import { io, Socket } from "socket.io-client";
import type {
  ClientIntent,
  GameLogEntry,
  GameSaveSnapshot,
  GameView,
  SeatStatus,
} from "../../shared/schemas";
import {
  AiLogFetchAckSchema,
  GameLogFetchAckSchema,
  GameSaveExportAckSchema,
  GameSaveImportAckSchema,
} from "../../shared/schemas";
import type {
  ActiveGameSummary,
  AvailableGame,
  BackendRuntimeInfo,
  GameSummary,
  RuleEngineMode,
  StatusSource,
  StatusTone,
} from "./state";
import type { AiLogEntry } from "../../shared/ai-log";

const ALLOW_INSECURE_HTTP = import.meta.env.VITE_ALLOW_INSECURE_HTTP === "true";
const SERVER_URL_OVERRIDE_STORAGE_KEY = "server-url-override";

function normalizeServerUrlInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
    ? trimmed
    : `${ALLOW_INSECURE_HTTP ? "http" : "https"}://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    if (!ALLOW_INSECURE_HTTP && parsed.protocol === "http:") {
      return null;
    }
    if (!parsed.port && parsed.protocol === "http:") {
      parsed.port = "3000";
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function readServerUrlOverride(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SERVER_URL_OVERRIDE_STORAGE_KEY);
    if (!raw) return null;
    return normalizeServerUrlInput(raw);
  } catch {
    return null;
  }
}

// In production we expect the backend to serve the frontend, so default to the
// current origin. In Vite dev we still want the API on port 3000 unless
// overridden via VITE_SERVER_URL.
const defaultServerUrl =
  import.meta.env.VITE_SERVER_URL ??
  (import.meta.env.DEV && typeof window !== "undefined" && window.location?.port
    ? `http://localhost:3000`
    : typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "http://localhost:3000");

export const SERVER_URL = readServerUrlOverride() ?? defaultServerUrl;

const DEFAULT_FETCH_TIMEOUT_MS = 15000;
const SOCKET_ACK_TIMEOUT_MS = 10000;
const SHORT_COMMIT_HASH_LENGTH = 7;

function normalizeCommitHash(raw: unknown): string {
  if (typeof raw !== "string") return "dev";
  const trimmed = raw.trim();
  if (!trimmed) return "dev";
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) return trimmed;
  return trimmed.slice(0, SHORT_COMMIT_HASH_LENGTH).toLowerCase();
}

export function getServerUrlOverride(): string | null {
  return readServerUrlOverride();
}

export function setServerUrlOverride(raw: string): string | null {
  if (typeof window === "undefined") return null;
  const normalized = normalizeServerUrlInput(raw);
  if (!normalized) return null;
  window.localStorage.setItem(SERVER_URL_OVERRIDE_STORAGE_KEY, normalized);
  return normalized;
}

export function clearServerUrlOverride(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SERVER_URL_OVERRIDE_STORAGE_KEY);
}

/**
 * Fetch with AbortController timeout to prevent indefinite hangs.
 */
async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readJsonOrThrow<T>(
  response: Response,
  context: string
): Promise<T> {
  const rawBody = await response.text();

  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    const compactBody = rawBody.replace(/\s+/g, " ").trim();
    const preview =
      compactBody.length > 120
        ? `${compactBody.slice(0, 120)}...`
        : compactBody || "<empty>";
    const isHtmlResponse =
      preview.toLowerCase().includes("<!doctype html") ||
      preview.toLowerCase().includes("<html");
    const endpoint = response.url || context;

    if (isHtmlResponse) {
      throw new Error(
        `${context}: server returned HTML at ${endpoint}. This usually means the backend URL points to a frontend site instead of the API server.`
      );
    }

    throw new Error(
      `${context}: server returned invalid JSON at ${endpoint} (${preview})`
    );
  }

  if (!response.ok) {
    throw new Error(`${context}: ${response.status}`);
  }

  return parsed as T;
}

type StatusPayload = {
  tone: StatusTone;
  message: string;
  source: StatusSource;
};

type Handlers = {
  onState: (view: GameView) => void;
  onStatus: (payload: StatusPayload) => void;
  onSeats: (payload: {
    gameId: string;
    seed?: string;
    seats: SeatStatus[];
  }) => void;
  onEvaluationComplete?: () => void;
  onGameStartSuccess?: (payload: {
    gameId: string;
    rulesId: string;
    seed?: string;
  }) => void;
  onGameEnded?: () => void;
  onGameNotFound?: () => void; // NEW
  onInvalidMove?: () => void;
  onAiLog?: (payload: {
    gameId: string;
    entries: AiLogEntry[];
    historicalUnavailable?: boolean;
  }) => void;
};

let socket: Socket | null = null;

export function ensureSocket(): Socket {
  if (!socket) {
    socket = io(SERVER_URL, {
      transports: ["websocket"],
    });
  }
  return socket;
}

export function setupSocketHandlers({
  onState,
  onStatus,
  onSeats,
  onEvaluationComplete,
  onGameStartSuccess,
  onGameEnded,
  onGameNotFound, // NEW
  onInvalidMove,
  onAiLog,
}: Handlers) {
  const s = ensureSocket();

  const markEvaluationComplete = () => {
    onEvaluationComplete?.();
  };

  const handleState = (view: GameView) => {
    onState(view);
    markEvaluationComplete();
  };
  const handleError = (payload: { message: string; source?: StatusSource }) => {
    onStatus({
      tone: "error",
      message: payload.message,
      source: payload.source ?? "app",
    });

    if (payload.message === "Game not found") {
      onGameNotFound?.();
    }

    onInvalidMove?.();
    markEvaluationComplete();
  };
  const handleValidation = (payload: {
    valid: boolean;
    reason?: string | null;
    nextPlayer?: string | null;
    source?: StatusSource;
  }) => {
    // Suppress success toasts; still surface errors.
    if (!payload.valid) {
      onStatus({
        tone: "error",
        message: payload.reason ?? "Invalid move",
        source: payload.source ?? "engine",
      });
    }
    if (payload.nextPlayer) {
      console.debug("Next player suggested", payload.nextPlayer);
    }
    if (!payload.valid) {
      onInvalidMove?.();
    }
    markEvaluationComplete();
  };
  const handleInvalid = () => {
    onInvalidMove?.();
    markEvaluationComplete();
  };
  const handleSeatStatus = (payload: { gameId: string; seats: SeatStatus[] }) =>
    onSeats(payload);

  const handleGameStatus = (payload: StatusPayload) => {
    onStatus(payload);
  };

  const handleGameStartSuccess = (payload: {
    gameId: string;
    rulesId: string;
    seed?: string;
  }) => {
    onGameStartSuccess?.(payload);
  };

  const handleGameEnded = () => {
    onGameEnded?.();
  };

  const handleAiLog = (payload: {
    gameId: string;
    entries: AiLogEntry[];
    historicalUnavailable?: boolean;
  }) => {
    onAiLog?.(payload);
  };

  s.on("game:state", handleState);
  s.on("game:error", handleError);
  s.on("game:validation", handleValidation);
  s.on("game:invalid", handleInvalid);
  s.on("game:seats", handleSeatStatus);
  s.on("game:status", handleGameStatus);
  s.on("game:start:success", handleGameStartSuccess);
  s.on("game:ended", handleGameEnded);
  s.on("game:ai-log", handleAiLog);

  return () => {
    s.off("game:state", handleState);
    s.off("game:error", handleError);
    s.off("game:validation", handleValidation);
    s.off("game:invalid", handleInvalid);
    s.off("game:seats", handleSeatStatus);
    s.off("game:status", handleGameStatus);
    s.off("game:start:success", handleGameStartSuccess);
    s.off("game:ended", handleGameEnded);
    s.off("game:ai-log", handleAiLog);
  };
}

export function setupConnectionHandlers(
  onConnect: () => void,
  onDisconnect: () => void
) {
  const s = ensureSocket();
  s.on("connect", onConnect);
  s.on("disconnect", onDisconnect);
  return () => {
    s.off("connect", onConnect);
    s.off("disconnect", onDisconnect);
  };
}

export function connect() {
  const s = ensureSocket();
  if (!s.connected) {
    s.connect();
  }
}

export function joinGame(
  gameId: string,
  playerId: string,
  role: "player" | "spectator" = "player",
  opts?: { isGodMode?: boolean }
) {
  const s = ensureSocket();
  s.emit("game:join", {
    gameId,
    playerId,
    role,
    isGodMode: opts?.isGodMode ?? false,
  });
}

export function watchGame(gameId: string) {
  const s = ensureSocket();
  s.emit("game:watch", { gameId });
}

export function leaveGame() {
  const s = ensureSocket();
  s.emit("game:leave");
}

export function restartGame(gameId: string) {
  const s = ensureSocket();
  s.emit("game:reset", gameId);
}

export function resetGameWithSeed(gameId: string, seed: string) {
  const s = ensureSocket();
  s.emit("game:reset-seed", { gameId, seed });
}

export function sendMoveIntent(
  gameId: string,
  playerId: string,
  fromPileId: string,
  toPileId: string,
  cardId: number,
  targetIndex?: number
) {
  const s = ensureSocket();
  const intent: {
    type: "move";
    gameId: string;
    playerId: string;
    fromPileId: string;
    toPileId: string;
    cardId: number;
    targetIndex?: number;
  } = {
    type: "move",
    gameId,
    playerId,
    fromPileId,
    toPileId,
    cardId,
  };
  if (typeof targetIndex === "number") {
    intent.targetIndex = targetIndex;
  }
  s.emit("game:intent", intent);
}

export function sendActionIntent(
  gameId: string,
  playerId: string,
  action: string
) {
  const s = ensureSocket();
  s.emit("game:intent", {
    type: "action",
    gameId,
    playerId,
    action,
  });
}

export function sendClientIntent(intent: ClientIntent) {
  const s = ensureSocket();
  s.emit("game:intent", intent);
}

export function setGodMode(gameId: string, isGodMode: boolean) {
  const s = ensureSocket();
  s.emit("game:set-god-mode", { gameId, isGodMode });
}

type StartGameOptions = {
  dedicatedLobby?: boolean;
  publicRoom?: boolean;
  resetDedicated?: boolean;
};

export function startGame(
  rulesId: string,
  seed?: string,
  options?: StartGameOptions
) {
  const s = ensureSocket();
  s.emit("game:start", rulesId, seed, options);
}

export async function exportGameSave(
  gameId: string
): Promise<GameSaveSnapshot> {
  const s = ensureSocket();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out while exporting save"));
    }, SOCKET_ACK_TIMEOUT_MS);

    s.emit("game:save-export", { gameId }, (rawAck: unknown) => {
      clearTimeout(timeout);

      const parsedAck = GameSaveExportAckSchema.safeParse(rawAck);
      if (!parsedAck.success) {
        reject(new Error("Invalid response while exporting save"));
        return;
      }

      const ack = parsedAck.data;
      if (!ack.ok) {
        reject(new Error(ack.message));
        return;
      }

      resolve(ack.snapshot);
    });
  });
}

export async function importGameSave(
  rawSnapshot: unknown
): Promise<{ gameId: string; rulesId: string }> {
  const s = ensureSocket();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out while loading save"));
    }, SOCKET_ACK_TIMEOUT_MS);

    s.emit("game:save-import", rawSnapshot, (rawAck: unknown) => {
      clearTimeout(timeout);

      const parsedAck = GameSaveImportAckSchema.safeParse(rawAck);
      if (!parsedAck.success) {
        reject(new Error("Invalid response while loading save"));
        return;
      }

      const ack = parsedAck.data;
      if (!ack.ok) {
        reject(new Error(ack.message));
        return;
      }

      resolve({
        gameId: ack.gameId,
        rulesId: ack.rulesId,
      });
    });
  });
}

export function setSeatAsAi(gameId: string, seatId: string, isAi: boolean) {
  const s = ensureSocket();
  s.emit("game:set-seat-ai", {
    gameId,
    seatId,
    isAi,
  });
}

export function setSeatFrontendAi(
  gameId: string,
  seatId: string,
  enabled: boolean
) {
  const s = ensureSocket();
  s.emit("game:setSeatFrontendAi", { gameId, seatId, enabled });
}

export async function fetchAvailableGames(): Promise<AvailableGame[]> {
  const response = await fetchWithTimeout(`${SERVER_URL}/games`);
  const data = await readJsonOrThrow<{ games?: unknown }>(
    response,
    "Failed to fetch available games"
  );
  const games: unknown[] = Array.isArray(data.games) ? data.games : [];
  const normalized: AvailableGame[] = [];

  for (const game of games) {
    if (typeof game === "string") {
      normalized.push({ id: game, name: game });
      continue;
    }
    if (game && typeof game === "object") {
      const maybeGame = game as {
        id?: unknown;
        name?: unknown;
        description?: unknown;
        category?: unknown;
        players?: unknown;
      };
      if (typeof maybeGame.id === "string") {
        normalized.push({
          id: maybeGame.id,
          name:
            typeof maybeGame.name === "string" ? maybeGame.name : maybeGame.id,
          description:
            typeof maybeGame.description === "string"
              ? maybeGame.description
              : undefined,
          category:
            typeof maybeGame.category === "string"
              ? maybeGame.category
              : undefined,
          players:
            typeof maybeGame.players === "number"
              ? maybeGame.players
              : undefined,
        });
      }
    }
  }

  return normalized;
}

export async function fetchActiveGames(): Promise<ActiveGameSummary[]> {
  const response = await fetchWithTimeout(`${SERVER_URL}/active-games`);
  const data = await readJsonOrThrow<{ games?: unknown }>(
    response,
    "Failed to fetch active games"
  );
  const games: unknown[] = Array.isArray(data.games) ? data.games : [];
  return games.map((g) => {
    const game = g as {
      gameId?: unknown;
      rulesId?: unknown;
      numSeats?: unknown;
      numOccupiedSeats?: unknown;
      numSpectators?: unknown;
      hasWinner?: unknown;
      roomType?: unknown;
      status?: unknown;
    };
    return {
      gameId: String(game.gameId ?? ""),
      rulesId: String(game.rulesId ?? ""),
      numSeats: Number(game.numSeats ?? 0),
      numOccupiedSeats: Number(game.numOccupiedSeats ?? 0),
      numSpectators: Number(game.numSpectators ?? 0),
      hasWinner: Boolean(game.hasWinner),
      roomType:
        game.roomType === "demo" || game.roomType === "public"
          ? game.roomType
          : "public",
      status:
        game.status === "playing" ||
        game.status === "finished" ||
        game.status === "waiting"
          ? game.status
          : "waiting",
    };
  });
}

export async function fetchGameInfo(
  gameId: string
): Promise<GameSummary | null> {
  const response = await fetchWithTimeout(
    `${SERVER_URL}/active-games/${encodeURIComponent(gameId)}`
  );
  if (response.status === 404) return null;
  const data = await readJsonOrThrow<{ game?: GameSummary }>(
    response,
    "Failed to fetch game info"
  );
  return data.game ?? null;
}

export async function closeGame(gameId: string): Promise<void> {
  const response = await fetchWithTimeout(
    `${SERVER_URL}/active-games/${encodeURIComponent(gameId)}`,
    { method: "DELETE" }
  );
  if (!response.ok) {
    throw new Error(`Failed to close game: ${response.status}`);
  }
}

export type ServerConfig = {
  ruleEngineMode: RuleEngineMode;
  serverAiEnabled?: boolean;
  llmShowPromptsInFrontend?: boolean;
  llmShowExceptionsInFrontend?: boolean;
  backendRuntime?: BackendRuntimeInfo;
};

export async function fetchServerConfig(): Promise<ServerConfig> {
  const response = await fetchWithTimeout(`${SERVER_URL}/config`);
  const data = (await readJsonOrThrow(response, "Failed to fetch config")) as {
    ruleEngineMode?: unknown;
    serverAiEnabled?: unknown;
    llmShowPromptsInFrontend?: unknown;
    llmShowExceptionsInFrontend?: unknown;
    backendCommitHash?: unknown;
    backendCommitUnixTs?: unknown;
  };
  const backendCommitHash = normalizeCommitHash(data.backendCommitHash);
  const backendCommitUnixTs =
    typeof data.backendCommitUnixTs === "number" &&
    Number.isFinite(data.backendCommitUnixTs) &&
    data.backendCommitUnixTs >= 0
      ? Math.floor(data.backendCommitUnixTs)
      : null;
  if (data.ruleEngineMode && data.ruleEngineMode !== "code") {
    console.warn(
      `Server reported legacy ruleEngineMode="${String(
        data.ruleEngineMode
      )}"; client will use code mode.`
    );
  }
  return {
    ruleEngineMode: "code",
    serverAiEnabled: data.serverAiEnabled === true,
    llmShowPromptsInFrontend: data.llmShowPromptsInFrontend === true,
    llmShowExceptionsInFrontend: data.llmShowExceptionsInFrontend === true,
    backendRuntime: {
      commitHash: backendCommitHash,
      commitUnixTs: backendCommitUnixTs,
    },
  };
}

export async function fetchAiLog(gameId: string): Promise<{
  entries: AiLogEntry[];
  historicalUnavailable: boolean;
}> {
  const s = ensureSocket();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out while fetching AI log"));
    }, SOCKET_ACK_TIMEOUT_MS);

    s.emit("game:get-ai-log", { gameId }, (rawAck: unknown) => {
      clearTimeout(timeout);
      const parsedAck = AiLogFetchAckSchema.safeParse(rawAck);
      if (!parsedAck.success) {
        reject(new Error("Invalid response while fetching AI log"));
        return;
      }

      resolve({
        entries: parsedAck.data.entries,
        historicalUnavailable: parsedAck.data.historicalUnavailable === true,
      });
    });
  });
}

export async function fetchGameLog(gameId: string): Promise<GameLogEntry[]> {
  const s = ensureSocket();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out while fetching game log"));
    }, SOCKET_ACK_TIMEOUT_MS);

    s.emit("game:get-log", { gameId }, (rawAck: unknown) => {
      clearTimeout(timeout);
      const parsedAck = GameLogFetchAckSchema.safeParse(rawAck);
      if (!parsedAck.success) {
        reject(new Error("Invalid response while fetching game log"));
        return;
      }

      const ack = parsedAck.data;
      if (!ack.ok) {
        reject(new Error(ack.message));
        return;
      }

      resolve(ack.entries);
    });
  });
}

export function appendAiLog(
  gameId: string,
  entry: Omit<AiLogEntry, "timestamp" | "gameId">
): void {
  const s = ensureSocket();
  s.emit("game:append-ai-log", {
    gameId,
    entry: {
      ...entry,
      gameId,
      timestamp: new Date().toISOString(),
    },
  });
}

export type AiPromptPayload = {
  gameId: string;
  playerId: string;
  requestedStateVersion: number;
  stateVersion: number;
  stale?: boolean;
  error?: string;
  messages?: unknown[];
  candidates?: Array<{ id: string; summary: string }>;
  context?: {
    candidates: Array<{ id: string; summary?: string; intent: unknown }>;
  };
};

export async function fetchAiPrompt(
  gameId: string,
  playerId: string,
  expectedStateVersion: number
): Promise<AiPromptPayload> {
  const s = ensureSocket();
  const timeoutMs = Number(import.meta.env.VITE_AI_PROMPT_TIMEOUT_MS) || 10000;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      s.off("game:ai-prompt-ready", handleReady);
      reject(new Error("Timeout waiting for AI prompt"));
    }, timeoutMs);

    const handleReady = (payload: AiPromptPayload) => {
      // ALWAYS remove handler to prevent memory leak, even if filter doesn't match
      clearTimeout(timeout);
      s.off("game:ai-prompt-ready", handleReady);

      if (
        payload.gameId === gameId &&
        payload.playerId === playerId &&
        payload.requestedStateVersion === expectedStateVersion
      ) {
        resolve(payload);
      } else {
        reject(
          new Error(
            `AI prompt response mismatch: expected (${gameId}, ${playerId}, ${expectedStateVersion}), ` +
              `got (${payload.gameId}, ${payload.playerId}, ${payload.requestedStateVersion})`
          )
        );
      }
    };

    s.on("game:ai-prompt-ready", handleReady);
    s.emit("game:prepare-ai-prompt", {
      gameId,
      playerId,
      expectedStateVersion,
    });
  });
}

export function logAiLlmRaw(
  gameId: string,
  playerId: string,
  turnNumber: number,
  content: string
): void {
  const s = ensureSocket();
  s.emit("game:ai-log-llm-raw", { gameId, playerId, turnNumber, content });
}

export function logAiLlmParsed(
  gameId: string,
  playerId: string,
  turnNumber: number,
  parsed: unknown
): void {
  const s = ensureSocket();
  s.emit("game:ai-log-llm-parsed", { gameId, playerId, turnNumber, parsed });
}

export function logAiLlmError(
  gameId: string,
  playerId: string,
  turnNumber: number,
  errorDetails: unknown
): void {
  const s = ensureSocket();
  s.emit("game:ai-log-llm-error", {
    gameId,
    playerId,
    turnNumber,
    errorDetails,
  });
}
