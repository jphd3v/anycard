import { Server, Socket } from "socket.io";
import { z } from "zod";
import type {
  ClientIntent,
  GameEvent,
  GameLogFetchAck,
  GameSaveExportAck,
  GameSaveImportAck,
  GameSaveSnapshot,
  GameState,
  LastAction,
  SeatStatus,
} from "../../shared/schemas.js";
import {
  ClientIntentSchema,
  GameEventSchema,
  GameSaveSnapshotSchema,
} from "../../shared/schemas.js";
import type { ValidationResult, EngineEvent } from "../../shared/validation.js";
import { loadAndValidateGameConfig } from "./game-config.js";
import {
  appendEvent,
  appendExecutedIntentFromClientIntent,
  applyEvent,
  getEvents,
  getExecutedIntents,
  getInitialState,
  initGame,
  projectState,
  projectStateWithEvents,
  resetGame,
  resetGameWithSeed,
  closeGame,
  getAllGameIds,
  updatePlayerAiStatus,
  setSeatRuntime,
  trimFinishedGamesNow,
  getHumanTurnNumber,
  getViewSalt,
  setExecutedIntents,
  getImportedEventCount,
  getImportedExecutedIntentCount,
  setImportedEventCount,
  setImportedExecutedIntentCount,
} from "./state.js";
import { forceRunAiTurnOnce, maybeScheduleAiTurn } from "./ai/ai-scheduler.js";
import { getWarmupWarningMessage } from "./ai/ai-llm-policy.js";
import { buildViewForPlayer } from "./view.js";
import {
  listLegalIntentsForPlayer,
  listLegalIntentsForView,
  validateMove,
} from "./rule-engine.js";
import { generateGameId } from "./util/game-id.js";
import {
  appendAiLogEntry,
  getAiLogSnapshot,
  markHistoricalAiTelemetryUnavailable,
  initAiLogIo,
  sendGameStatus,
  type AiLogEntry,
} from "./ai/ai-log.js";
import { GAME_PLUGINS } from "./rules/registry.js";
import { resolveEngineCardId, toViewCardId } from "./view-ids.js";
import { applyLegalActionsToView } from "./util/actions.js";
import { getSuitSymbol } from "./util/card-notation.js";
import { isPileVisibleToPlayer } from "./visibility.js";
import { parseSaveSnapshotForImport } from "./save-import.js";
import { buildDeterministicGameLog } from "./game-log.js";
import { resolveEventAttribution } from "./event-attribution.js";
import { buildGameSaveSnapshot } from "./save-snapshot.js";
import type {
  PersistedRoomType,
  SupabasePersistedGameRecord,
} from "./persistence/supabase-autosave.js";
import {
  claimSeatOwnership,
  ensureGameHostUserId,
  getGameHostUserId,
  getSeatClaimCleanupIntervalMs,
  getSeatClaimReleaseTimeoutSeconds,
  isSupabaseIdentityEnabled,
  listSeatClaimsForGame,
  markSeatClaimDisconnected,
  normalizeAvatarEmoji,
  releaseAllClaimsForGame,
  releaseExpiredSeatClaims,
  releaseSeatOwnership,
  releaseSeatOwnershipForAiSeat,
  setSeatClaimAvatarEmoji,
  upsertUserProfileAvatar,
  verifySupabaseAccessToken,
  type SeatClaimRecord,
} from "./identity/supabase-identity.js";

// Module-scoped state
type PlayerRole = "player" | "spectator";
type RoomType = "demo" | "public" | "private";
type PlayerRegistryEntry = {
  gameId: string;
  playerId: string;
  role: PlayerRole;
  isGodMode?: boolean;
  userId?: string | null;
  userEmail?: string | null;
  guestId?: string | null;
};

type GuestSeatClaimRecord = {
  gameId: string;
  seatId: string;
  ownerGuestId: string;
};

type PersistedStorage = "supabase";
type GamePersistenceSummary = {
  storage: PersistedStorage;
  persistedAt?: string;
  hydratedFrom?: PersistedStorage;
  hydratedAt?: string;
};

export type ActiveGameSummary = {
  gameId: string;
  rulesId: string;
  numSeats: number;
  numOccupiedSeats: number;
  numSpectators: number;
  hasWinner: boolean;
  roomType: RoomType;
  status: "waiting" | "playing" | "finished";
  persistence?: GamePersistenceSummary;
};

export type GameSummary = {
  gameId: string;
  rulesId: string;
  gameName: string;
  numSeats: number;
  numOccupiedSeats: number;
  numSpectators: number;
  hasWinner: boolean;
  roomType: RoomType;
  players: { id: string; name?: string; occupied: boolean }[];
  seed?: string;
  status: "waiting" | "playing" | "finished";
  persistence?: GamePersistenceSummary;
};

const playerRegistry = new Map<string, PlayerRegistryEntry>();
const watchRegistry = new Map<string, string>(); // socketId -> gameId
const seatAssignments = new Map<string, string>(); // key: `${gameId}:${playerId}` -> socketId
const deadlockAssertStateVersionByGame = new Map<string, number>();

const DEADLOCK_ASSERT_PREFIX = "[DEADLOCK_ASSERT]";
const gameProcessingChains = new Map<string, Promise<void>>();
const demoRoomsByRulesId = new Map<string, string>(); // rulesId -> gameId
const roomTypeByGameId = new Map<string, RoomType>();
const persistenceByGameId = new Map<string, GamePersistenceSummary>();
const pendingCloseTimers = new Map<string, NodeJS.Timeout>();
const seatClaimsByGameId = new Map<string, Map<string, SeatClaimRecord>>();
const guestSeatClaimsByGameId = new Map<
  string,
  Map<string, GuestSeatClaimRecord>
>();
const seatClaimsLoadedForGameId = new Set<string>();
const hostUserIdByGameId = new Map<string, string>();
let seatClaimCleanupTimer: NodeJS.Timeout | null = null;
const authRefreshTimestamps = new Map<string, number>();
const NO_HUMAN_CLOSE_DELAY_MS = 15 * 60 * 1000;
const DEFAULT_DEMO_SEED = "ESC0Q0";
const AUTH_REFRESH_COOLDOWN_MS = 30_000;
const GUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

// Schemas for validation
const StartGameOptionsSchema = z.object({
  dedicatedLobby: z.boolean().optional(),
  publicRoom: z.boolean().optional(),
  resetDedicated: z.boolean().optional(),
});

const ErrorDetailsSchema = z.record(z.string(), z.unknown());

// Utility functions for code quality
type AiRuntimeLocation = "none" | "backend" | "frontend";

/**
 * Get the AI runtime location for a player.
 * Extracted from repeated pattern throughout the codebase.
 */
function getAiRuntime(player: {
  aiRuntime?: AiRuntimeLocation;
  isAi?: boolean;
}): AiRuntimeLocation {
  return player.aiRuntime ?? (player.isAi ? "backend" : "none");
}

/**
 * Resolve the AI runtime for a seat.
 * Extracted from repeated inline function definitions.
 */
function resolveSeatRuntime(seat: {
  aiRuntime?: AiRuntimeLocation;
  isAi?: boolean;
}): AiRuntimeLocation {
  return seat.aiRuntime ?? (seat.isAi ? "backend" : "none");
}

/**
 * Check if a spectator can perform an action.
 * Spectators can only start fully-automated (AI-only) games.
 */
function canSpectatorPerformAction(
  state: GameState,
  role: PlayerRole
): boolean {
  if (role !== "spectator") return true;

  return (
    state.players.length > 0 &&
    state.players.every((p) => getAiRuntime(p) !== "none")
  );
}

function getSocketUserId(socket: Socket): string | null {
  const candidate = (socket.data as { userId?: unknown } | undefined)?.userId;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate
    : null;
}

function getSocketUserEmail(socket: Socket): string | null {
  const candidate = (socket.data as { userEmail?: unknown } | undefined)
    ?.userEmail;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate
    : null;
}

function normalizeGuestId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!GUEST_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function getSocketGuestId(socket: Socket): string | null {
  const candidate = (socket.data as { guestId?: unknown } | undefined)?.guestId;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate
    : null;
}

function getSeatClaimTimeoutMs(): number {
  return getSeatClaimReleaseTimeoutSeconds() * 1000;
}

function isSupabaseSeatClaimActive(claim: SeatClaimRecord | null): boolean {
  if (!claim) return false;
  if (!claim.disconnectedAt) return true;
  const disconnectedAt = Date.parse(claim.disconnectedAt);
  if (!Number.isFinite(disconnectedAt)) return true;
  return Date.now() - disconnectedAt <= getSeatClaimTimeoutMs();
}

function isGuestSeatClaimActive(claim: GuestSeatClaimRecord | null): boolean {
  return claim != null;
}

function getGuestSeatClaimMap(
  gameId: string
): Map<string, GuestSeatClaimRecord> {
  let gameClaims = guestSeatClaimsByGameId.get(gameId);
  if (!gameClaims) {
    gameClaims = new Map<string, GuestSeatClaimRecord>();
    guestSeatClaimsByGameId.set(gameId, gameClaims);
  }
  return gameClaims;
}

function getGuestSeatClaimFromCache(
  gameId: string,
  seatId: string
): GuestSeatClaimRecord | null {
  return guestSeatClaimsByGameId.get(gameId)?.get(seatId) ?? null;
}

function setGuestSeatClaimInCache(claim: GuestSeatClaimRecord): void {
  const gameClaims = getGuestSeatClaimMap(claim.gameId);
  gameClaims.set(claim.seatId, claim);
}

function removeGuestSeatClaimFromCache(gameId: string, seatId: string): void {
  const gameClaims = guestSeatClaimsByGameId.get(gameId);
  if (!gameClaims) return;
  gameClaims.delete(seatId);
  if (gameClaims.size === 0) {
    guestSeatClaimsByGameId.delete(gameId);
  }
}

function clearGuestSeatClaimsCacheForGame(gameId: string): void {
  guestSeatClaimsByGameId.delete(gameId);
}

function claimGuestSeatOwnership(params: {
  gameId: string;
  seatId: string;
  guestId: string;
}):
  | { ok: true; claim: GuestSeatClaimRecord }
  | { ok: false; reason: "owned-by-other" } {
  const existing = getGuestSeatClaimFromCache(params.gameId, params.seatId);
  if (
    existing &&
    existing.ownerGuestId !== params.guestId &&
    isGuestSeatClaimActive(existing)
  ) {
    return { ok: false, reason: "owned-by-other" };
  }

  const next: GuestSeatClaimRecord = {
    gameId: params.gameId,
    seatId: params.seatId,
    ownerGuestId: params.guestId,
  };
  setGuestSeatClaimInCache(next);
  return { ok: true, claim: next };
}

function markGuestSeatClaimDisconnected(params: {
  gameId: string;
  seatId: string;
  guestId: string;
}): GuestSeatClaimRecord | null {
  const existing = getGuestSeatClaimFromCache(params.gameId, params.seatId);
  if (!existing || existing.ownerGuestId !== params.guestId) {
    return null;
  }
  removeGuestSeatClaimFromCache(params.gameId, params.seatId);
  return null;
}

function releaseGuestSeatOwnership(params: {
  gameId: string;
  seatId: string;
  requesterGuestId?: string | null;
  force?: boolean;
}): boolean {
  const existing = getGuestSeatClaimFromCache(params.gameId, params.seatId);
  if (!existing) return true;
  if (!params.force && params.requesterGuestId !== existing.ownerGuestId) {
    return false;
  }
  removeGuestSeatClaimFromCache(params.gameId, params.seatId);
  return true;
}

function getSeatClaimMap(gameId: string): Map<string, SeatClaimRecord> {
  let gameClaims = seatClaimsByGameId.get(gameId);
  if (!gameClaims) {
    gameClaims = new Map<string, SeatClaimRecord>();
    seatClaimsByGameId.set(gameId, gameClaims);
  }
  return gameClaims;
}

function setSeatClaimInCache(claim: SeatClaimRecord): void {
  const gameClaims = getSeatClaimMap(claim.gameId);
  gameClaims.set(claim.seatId, claim);
}

function removeSeatClaimFromCache(gameId: string, seatId: string): void {
  const gameClaims = seatClaimsByGameId.get(gameId);
  if (!gameClaims) return;
  gameClaims.delete(seatId);
  if (gameClaims.size === 0) {
    seatClaimsByGameId.delete(gameId);
  }
}

function clearSeatClaimsCacheForGame(gameId: string): void {
  seatClaimsByGameId.delete(gameId);
  seatClaimsLoadedForGameId.delete(gameId);
  hostUserIdByGameId.delete(gameId);
  clearGuestSeatClaimsCacheForGame(gameId);
}

async function ensureSeatClaimsLoadedForGame(gameId: string): Promise<void> {
  if (!isSupabaseIdentityEnabled()) return;
  if (seatClaimsLoadedForGameId.has(gameId)) return;
  const claims = await listSeatClaimsForGame(gameId);
  const gameClaims = getSeatClaimMap(gameId);
  gameClaims.clear();
  for (const claim of claims) {
    gameClaims.set(claim.seatId, claim);
  }
  seatClaimsLoadedForGameId.add(gameId);
}

function getSeatClaimFromCache(
  gameId: string,
  seatId: string
): SeatClaimRecord | null {
  return seatClaimsByGameId.get(gameId)?.get(seatId) ?? null;
}

export function getSeatAvatarEmoji(
  gameId: string,
  seatId: string
): string | undefined {
  const claim = getSeatClaimFromCache(gameId, seatId);
  return claim?.avatarEmoji ?? undefined;
}

export function getSeatOwnerLabel(
  gameId: string,
  seatId: string
): string | undefined {
  const assignmentKey = seatKey(gameId, seatId);
  const occupantSocketId = seatAssignments.get(assignmentKey);
  const occupantEntry = occupantSocketId
    ? playerRegistry.get(occupantSocketId)
    : null;
  if (occupantEntry?.userEmail) return occupantEntry.userEmail;
  if (occupantEntry?.guestId) {
    return `Guest ${occupantEntry.guestId.slice(-4)}`;
  }

  const supabaseClaim = getSeatClaimFromCache(gameId, seatId);
  if (isSupabaseSeatClaimActive(supabaseClaim)) {
    return "Signed-in player";
  }

  const guestClaim = getGuestSeatClaimFromCache(gameId, seatId);
  if (guestClaim && isGuestSeatClaimActive(guestClaim)) {
    return `Guest ${guestClaim.ownerGuestId.slice(-4)}`;
  }

  return undefined;
}

async function setHostUserIfMissing(
  gameId: string,
  userId: string | null
): Promise<void> {
  if (!isSupabaseIdentityEnabled()) return;
  if (!userId) return;

  const cached = hostUserIdByGameId.get(gameId);
  if (cached) return;

  const hostUserId = await ensureGameHostUserId(gameId, userId);
  if (hostUserId) {
    hostUserIdByGameId.set(gameId, hostUserId);
  }
}

async function isHostUserForGame(
  gameId: string,
  userId: string | null
): Promise<boolean> {
  if (!userId) return false;
  const cached = hostUserIdByGameId.get(gameId);
  if (cached) return cached === userId;

  if (!isSupabaseIdentityEnabled()) return false;
  const loadedHost = await getGameHostUserId(gameId);
  if (loadedHost) {
    hostUserIdByGameId.set(gameId, loadedHost);
  }
  return loadedHost === userId;
}

async function hasHostUserForGame(gameId: string): Promise<boolean> {
  if (!isSupabaseIdentityEnabled()) return false;
  if (hostUserIdByGameId.has(gameId)) {
    return true;
  }
  const loadedHost = await getGameHostUserId(gameId);
  if (!loadedHost) return false;
  hostUserIdByGameId.set(gameId, loadedHost);
  return true;
}

async function markSeatClaimDisconnectedForEntry(
  entry: PlayerRegistryEntry
): Promise<void> {
  if (entry.role !== "player") return;
  if (entry.userId && isSupabaseIdentityEnabled()) {
    const claim = await markSeatClaimDisconnected({
      gameId: entry.gameId,
      seatId: entry.playerId,
      userId: entry.userId,
    });
    if (claim) {
      setSeatClaimInCache(claim);
    }
    return;
  }

  if (entry.guestId) {
    markGuestSeatClaimDisconnected({
      gameId: entry.gameId,
      seatId: entry.playerId,
      guestId: entry.guestId,
    });
  }
}

async function runSeatClaimCleanup(): Promise<void> {
  const touchedGameIds = new Set<string>();

  if (isSupabaseIdentityEnabled()) {
    const released = await releaseExpiredSeatClaims();
    for (const claim of released) {
      removeSeatClaimFromCache(claim.gameId, claim.seatId);
      touchedGameIds.add(claim.gameId);
    }
  }

  for (const [gameId, claims] of guestSeatClaimsByGameId.entries()) {
    // Guest claims are removed eagerly on disconnect/release. Keep this loop as
    // structural scaffolding in case guest reconnect grace-period cleanup is added.
    if (claims.size === 0) {
      guestSeatClaimsByGameId.delete(gameId);
    }
  }

  if (touchedGameIds.size === 0) return;

  for (const gameId of touchedGameIds) {
    if (projectState(gameId)) {
      broadcastSeatStatus(gameId);
      broadcastStateToGame(gameId);
    }
  }
}

function countConnectedHumans(gameId: string): {
  playerCount: number;
  spectatorCount: number;
} {
  let playerCount = 0;
  let spectatorCount = 0;

  for (const entry of playerRegistry.values()) {
    if (entry.gameId !== gameId) continue;
    if (entry.role === "player") {
      playerCount += 1;
    } else {
      spectatorCount += 1;
    }
  }

  for (const watchedGameId of watchRegistry.values()) {
    if (watchedGameId === gameId) {
      spectatorCount += 1;
    }
  }

  return { playerCount, spectatorCount };
}

export function getRoomType(gameId: string): RoomType {
  return roomTypeByGameId.get(gameId) ?? "private";
}

export function isHostConnectionForGame(
  gameId: string,
  connectionId?: string
): boolean {
  if (!connectionId) return false;
  const entry = playerRegistry.get(connectionId);
  const userId = entry?.userId ?? null;
  if (!userId) return false;
  return hostUserIdByGameId.get(gameId) === userId;
}

export async function isUserHostForGame(
  gameId: string,
  userId: string
): Promise<boolean> {
  return isHostUserForGame(gameId, userId);
}

function normalizePersistedRoomType(roomType: PersistedRoomType): RoomType {
  return roomType === "demo" || roomType === "public" || roomType === "private"
    ? roomType
    : "private";
}

function isValidIsoDatetime(value: string | undefined): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function setGamePersistenceSummary(
  gameId: string,
  update: Partial<GamePersistenceSummary> & { storage: PersistedStorage }
): void {
  const previous = persistenceByGameId.get(gameId);
  const next: GamePersistenceSummary = {
    storage: update.storage,
    ...(previous?.persistedAt ? { persistedAt: previous.persistedAt } : {}),
    ...(previous?.hydratedFrom
      ? { hydratedFrom: previous.hydratedFrom, hydratedAt: previous.hydratedAt }
      : {}),
  };

  if (isValidIsoDatetime(update.persistedAt)) {
    next.persistedAt = update.persistedAt;
  }
  if (update.hydratedFrom) {
    next.hydratedFrom = update.hydratedFrom;
    if (isValidIsoDatetime(update.hydratedAt)) {
      next.hydratedAt = update.hydratedAt;
    }
  }

  persistenceByGameId.set(gameId, next);
}

function getGamePersistenceSummary(
  gameId: string
): GamePersistenceSummary | undefined {
  const summary = persistenceByGameId.get(gameId);
  if (!summary) return undefined;
  return {
    storage: summary.storage,
    ...(summary.persistedAt ? { persistedAt: summary.persistedAt } : {}),
    ...(summary.hydratedFrom
      ? {
          hydratedFrom: summary.hydratedFrom,
          ...(summary.hydratedAt ? { hydratedAt: summary.hydratedAt } : {}),
        }
      : {}),
  };
}

export function getGamePersistenceMetadata(
  gameId: string
): Record<string, string> | undefined {
  const summary = getGamePersistenceSummary(gameId);
  if (!summary) return undefined;
  const metadata: Record<string, string> = {
    saveStorage: summary.storage,
  };
  if (summary.persistedAt) {
    metadata.savePersistedAt = summary.persistedAt;
  }
  if (summary.hydratedFrom) {
    metadata.saveHydratedFrom = summary.hydratedFrom;
  }
  if (summary.hydratedAt) {
    metadata.saveHydratedAt = summary.hydratedAt;
  }
  return metadata;
}

export function notePersistedSnapshot(payload: {
  gameId: string;
  roomType: PersistedRoomType;
  persistedAt: string;
  storage?: PersistedStorage;
}): void {
  const roomType = normalizePersistedRoomType(payload.roomType);
  setRoomType(payload.gameId, roomType);
  setGamePersistenceSummary(payload.gameId, {
    storage: payload.storage ?? "supabase",
    persistedAt: payload.persistedAt,
  });
}

export function noteDeletedSnapshot(payload: { gameId: string }): void {
  // Keep metadata while in memory so UI can still show last persistence status.
  if (!projectState(payload.gameId)) {
    persistenceByGameId.delete(payload.gameId);
  }
}

function isDemoRoom(gameId: string): boolean {
  return getRoomType(gameId) === "demo";
}

function setRoomType(gameId: string, type: RoomType): void {
  roomTypeByGameId.set(gameId, type);
}

function ensureDemoRoom(rulesId: string): string | null {
  const existingId = demoRoomsByRulesId.get(rulesId);
  if (existingId) {
    const existingState = projectState(existingId);
    if (existingState) {
      setRoomType(existingId, "demo");
      return existingId;
    }
    demoRoomsByRulesId.delete(rulesId);
  }

  const initialState = loadAndValidateGameConfig(rulesId, DEFAULT_DEMO_SEED);
  const gameId = generateGameId();
  const stateForGame: GameState = { ...initialState, gameId };
  setRoomType(gameId, "demo");

  try {
    initGame(stateForGame);
  } catch (err) {
    roomTypeByGameId.delete(gameId);
    console.warn(
      `[Demo Rooms] Failed to create demo room for rulesId="%s"`,
      rulesId,
      err
    );
    return null;
  }

  demoRoomsByRulesId.set(rulesId, gameId);
  setRoomType(gameId, "demo");
  return gameId;
}

function ensureDemoRooms(): void {
  for (const rulesId of Object.keys(GAME_PLUGINS)) {
    ensureDemoRoom(rulesId);
  }
}

function clearPendingClose(gameId: string): void {
  const timer = pendingCloseTimers.get(gameId);
  if (!timer) return;
  clearTimeout(timer);
  pendingCloseTimers.delete(gameId);
}

export function closeGameSession(io: Server, gameId: string): boolean {
  clearPendingClose(gameId);
  if (isDemoRoom(gameId)) {
    return false;
  }
  const state = projectState(gameId);
  if (!state) {
    return false;
  }

  io.to(gameId).emit("game:error", {
    message: "Game not found",
    source: "app",
  });

  for (const [socketId, entry] of playerRegistry.entries()) {
    if (entry.gameId !== gameId) continue;
    playerRegistry.delete(socketId);
    const socket = io.sockets.sockets.get(socketId);
    socket?.leave(gameId);
  }

  for (const [socketId, watchedGameId] of watchRegistry.entries()) {
    if (watchedGameId !== gameId) continue;
    watchRegistry.delete(socketId);
    const socket = io.sockets.sockets.get(socketId);
    socket?.leave(gameId);
  }

  for (const key of seatAssignments.keys()) {
    if (key.startsWith(`${gameId}:`)) {
      seatAssignments.delete(key);
    }
  }

  for (const [rulesId, demoGameId] of demoRoomsByRulesId.entries()) {
    if (demoGameId === gameId) {
      demoRoomsByRulesId.delete(rulesId);
    }
  }

  roomTypeByGameId.delete(gameId);
  persistenceByGameId.delete(gameId);
  if (isSupabaseIdentityEnabled()) {
    void releaseAllClaimsForGame(gameId);
  }
  clearSeatClaimsCacheForGame(gameId);
  gameProcessingChains.delete(gameId);
  deadlockAssertStateVersionByGame.delete(gameId);
  closeGame(gameId);
  return true;
}

function shouldCloseGameForNoHumans(gameId: string): boolean {
  const state = projectState(gameId);
  if (!state) return false;

  const { playerCount, spectatorCount } = countConnectedHumans(gameId);
  if (playerCount + spectatorCount > 0) {
    return false;
  }

  // Keep abandoned unfinished games available for later resume.
  return state.winner != null;
}

function maybeCloseAbandonedGame(io: Server, gameId: string): boolean {
  if (!shouldCloseGameForNoHumans(gameId)) {
    clearPendingClose(gameId);
    return false;
  }

  if (pendingCloseTimers.has(gameId)) {
    return false;
  }

  // Eligible abandoned games wait for timeout to allow reconnecting users.
  const delay = NO_HUMAN_CLOSE_DELAY_MS;

  const timer = setTimeout(() => {
    pendingCloseTimers.delete(gameId);
    if (!shouldCloseGameForNoHumans(gameId)) {
      return;
    }

    closeGameSession(io, gameId);
  }, delay);

  pendingCloseTimers.set(gameId, timer);
  return false;
}

// Global variable to store server instance for AI system to broadcast state
let globalIoServer: Server | null = null;

function findActionLabel(
  state: GameState,
  actionId: string
): string | undefined {
  return state.actions?.cells?.find((cell) => cell.id === actionId)?.label;
}

function findMoveLabel(
  state: GameState,
  intent: ClientIntent,
  viewerId?: string
): string {
  if (intent.type !== "move") return "Move Card";
  const card = state.cards[intent.cardId!];
  if (!card) return "Move Card";

  if (viewerId && viewerId !== "__god__") {
    const fromPile = state.piles[intent.fromPileId];
    const toPile = state.piles[intent.toPileId];
    const visibleBefore = fromPile
      ? isPileVisibleToPlayer(fromPile, viewerId)
      : false;
    const visibleAfter = toPile
      ? isPileVisibleToPlayer(toPile, viewerId)
      : false;

    if (!visibleBefore && !visibleAfter) {
      if (intent.toPileId.includes("hand") || intent.fromPileId === "deck") {
        return "Draw Card";
      }
      return "Move Card";
    }
  }

  const cardLabel = card.label || `${card.rank}${getSuitSymbol(card.suit)}`;
  return cardLabel;
}

function appendGameLogIntent(
  state: GameState,
  intent: ClientIntent,
  turnNumber: number
): void {
  let label =
    intent.type === "action"
      ? (findActionLabel(state, intent.action) ?? intent.action)
      : findMoveLabel(state, intent, "__spectator__");
  let prefix = intent.type === "action" ? "Action" : "Move";

  if (intent.type === "action" && intent.action === "start-game") {
    prefix = "SETUP";
    // If we have a rulesState and it's not the first deal, call it Next Round
    const rs = state.rulesState as { dealNumber?: number } | null;
    if (rs && typeof rs.dealNumber === "number" && rs.dealNumber > 0) {
      label = "Next Round";
    }
  }

  appendAiLogEntry({
    gameId: state.gameId,
    turnNumber,
    playerId: intent.playerId,
    phase: "game",
    level: "info",
    message: `${prefix}: ${label}`,
    details: {
      kind: "game-intent",
      intentType: intent.type,
      label,
      ...(intent.type === "action"
        ? { actionId: intent.action }
        : { fromPileId: intent.fromPileId, toPileId: intent.toPileId }),
    },
  });
}

// Function to broadcast state to all players in a game
export function broadcastStateToGame(
  gameId: string,
  lastEngineEvents?: EngineEvent[],
  lastAction?: LastAction
): void {
  if (!globalIoServer) {
    console.error("Global IO server not initialized for broadcast");
    return;
  }

  const state = projectState(gameId);
  if (!state) {
    // Use separate arguments to prevent format string injection
    console.error("Game not found for broadcast:", { gameId });
    return;
  }

  const shouldRunDeadlockCheck = !lastEngineEvents?.some(
    (event) => event.type === "fatal-error"
  );
  if (shouldRunDeadlockCheck) {
    const maybeDeadlock = detectTurnDeadlock(gameId, state);
    if (maybeDeadlock) {
      const stateVersionBeforeFatal = getEvents(gameId).length;
      const fatalEvent: GameEvent = {
        id: Date.now(),
        gameId,
        playerId: null,
        type: "fatal-error",
        message: maybeDeadlock.message,
        source: "engine",
      };
      appendEvent(gameId, fatalEvent);
      deadlockAssertStateVersionByGame.set(gameId, stateVersionBeforeFatal + 1);

      broadcastState(globalIoServer, playerRegistry, state, [
        {
          type: "fatal-error",
          message: maybeDeadlock.message,
          source: "engine",
        },
      ]);
      return;
    }
  }

  broadcastState(
    globalIoServer,
    playerRegistry,
    state,
    lastEngineEvents,
    lastAction
  );
}

function detectTurnDeadlock(
  gameId: string,
  state: GameState
): { message: string } | null {
  const plugin = GAME_PLUGINS[state.rulesId];
  if (!plugin || !plugin.ruleModule.listLegalIntentsForPlayer) {
    return null;
  }

  if (state.winner) {
    deadlockAssertStateVersionByGame.delete(gameId);
    return null;
  }

  const currentPlayer = state.currentPlayer;
  if (!currentPlayer) {
    deadlockAssertStateVersionByGame.delete(gameId);
    return null;
  }

  const stateVersion = getEvents(gameId).length;
  if (deadlockAssertStateVersionByGame.get(gameId) === stateVersion) {
    return null;
  }

  try {
    const currentPlayerIntents = listLegalIntentsForPlayer(
      gameId,
      currentPlayer
    );
    if (currentPlayerIntents.length > 0) {
      deadlockAssertStateVersionByGame.delete(gameId);
      return null;
    }

    const otherPlayersWithIntents = state.players
      .map((player) => player.id)
      .filter((playerId) => playerId !== currentPlayer)
      .map((playerId) => ({
        playerId,
        count: listLegalIntentsForPlayer(gameId, playerId).length,
      }))
      .filter((entry) => entry.count > 0);

    const rulesState =
      state.rulesState && typeof state.rulesState === "object"
        ? (state.rulesState as Record<string, unknown>)
        : null;
    const phase =
      rulesState && typeof rulesState.phase === "string"
        ? rulesState.phase
        : "unknown";

    const detail =
      otherPlayersWithIntents.length > 0
        ? `current player "${currentPlayer}" has no legal intents while other players do (${otherPlayersWithIntents
            .map((entry) => `${entry.playerId}:${entry.count}`)
            .join(", ")})`
        : `current player "${currentPlayer}" has no legal intents and no other player has legal intents`;

    return {
      message: `${DEADLOCK_ASSERT_PREFIX} ${detail}. game=${gameId} rules=${state.rulesId} phase=${phase}`,
    };
  } catch (error) {
    console.error("[DEADLOCK_ASSERT] Failed to evaluate deadlock", {
      gameId,
      error,
    });
    return null;
  }
}

function enqueueGameWork(gameId: string, work: () => Promise<void>): void {
  const previous = gameProcessingChains.get(gameId) ?? Promise.resolve();

  const next = previous
    .catch((err) => {
      // Log previous work failure but don't break the chain
      console.error(`[game:intent] Previous work failed:`, {
        gameId,
        error: err,
      });
      // Notify users of the error
      if (globalIoServer) {
        globalIoServer.to(gameId).emit("game:error", {
          message:
            "A previous game action failed. Please refresh if issues persist.",
          source: "app",
        });
      }
    })
    .then(work)
    .catch((err) => {
      console.error(`[game:intent] Error in game:`, { gameId, error: err });
      // Notify users that the current work failed
      if (globalIoServer) {
        globalIoServer.to(gameId).emit("game:error", {
          message:
            err instanceof Error ? err.message : "An unexpected error occurred",
          source: "app",
        });
      }
    })
    .finally(() => {
      // Race-safe deletion: only delete if no new work was enqueued after us
      // This is atomic because JavaScript is single-threaded and there are no await points
      const currentChain = gameProcessingChains.get(gameId);
      if (currentChain === next) {
        gameProcessingChains.delete(gameId);
      }
    });

  gameProcessingChains.set(gameId, next);
}

function seatKey(gameId: string, playerId: string): string {
  return `${gameId}:${playerId}`;
}

type GameSaveExportCallback = (response: GameSaveExportAck) => void;
type GameSaveImportCallback = (response: GameSaveImportAck) => void;
type GameLogFetchCallback = (response: GameLogFetchAck) => void;

function resolveGameLogViewerId(socketId: string, gameId: string): string {
  const registryEntry = playerRegistry.get(socketId);
  if (registryEntry && registryEntry.gameId === gameId) {
    if (registryEntry.isGodMode) return "__god__";
    if (registryEntry.role === "spectator") return "__spectator__";
    return registryEntry.playerId;
  }

  if (watchRegistry.get(socketId) === gameId) {
    return "__spectator__";
  }

  // Defensive fallback for unexpected states after access checks.
  return "__spectator__";
}

function buildGameLogEntries(gameId: string, viewerId: string) {
  const initialState = getInitialState(gameId);
  if (!initialState) {
    return null;
  }
  const events = getEvents(gameId);
  const executedIntents = getExecutedIntents(gameId);
  const plugin = GAME_PLUGINS[initialState.rulesId];
  const importedEventCount = getImportedEventCount(gameId);
  const importedExecutedIntentCount = getImportedExecutedIntentCount(gameId);
  return buildDeterministicGameLog(initialState, events, plugin, {
    importedEventCount,
    importedExecutedIntentCount,
    executedIntents,
    viewerId,
  });
}

function hasGameAccess(socketId: string, gameId: string): boolean {
  const registryEntry = playerRegistry.get(socketId);
  if (registryEntry) {
    return registryEntry.gameId === gameId;
  }
  if (watchRegistry.get(socketId) === gameId) {
    return true;
  }

  // Allow sockets that are already in the room but have not yet been
  // registered in watch/player maps during startup/auto-watch races.
  const socket = globalIoServer?.sockets.sockets.get(socketId);
  return socket?.rooms.has(gameId) === true;
}

function stopWatching(socket: Socket, keepRoomId?: string): void {
  const watchedGameId = watchRegistry.get(socket.id);
  if (!watchedGameId) return;
  watchRegistry.delete(socket.id);
  if (watchedGameId !== keepRoomId) {
    socket.leave(watchedGameId);
  }
}

function clearSponsoredAiForSocket(gameId: string, socketId: string): boolean {
  const snapshot = projectState(gameId);
  if (!snapshot) {
    return false;
  }

  let cleared = false;
  for (const player of snapshot.players) {
    const aiRuntime =
      player.aiRuntime ??
      (player.isAi ? ("backend" as const) : ("none" as const));
    if (aiRuntime === "frontend" && player.aiSponsorConnectionId === socketId) {
      setSeatRuntime(gameId, player.id, "none", null);
      cleared = true;
    }
  }

  return cleared;
}

function buildSeatStatusPayload(
  gameId: string,
  seatAssignments: Map<string, string>
): { gameId: string; seed?: string; seats: SeatStatus[] } {
  const snapshot = projectState(gameId);
  const players = snapshot?.players ?? [];

  return {
    gameId,
    seed: snapshot?.seed,
    seats: players.map((player) => {
      const aiRuntime =
        player.aiRuntime ??
        (player.isAi ? ("backend" as const) : ("none" as const));
      const assignmentKey = seatKey(gameId, player.id);
      const occupantSocketId = seatAssignments.get(assignmentKey);
      const occupantEntry = occupantSocketId
        ? playerRegistry.get(occupantSocketId)
        : null;
      const supabaseClaim = getSeatClaimFromCache(gameId, player.id);
      const guestClaim = getGuestSeatClaimFromCache(gameId, player.id);
      const occupied =
        occupantSocketId != null ||
        aiRuntime !== "none" ||
        isSupabaseSeatClaimActive(supabaseClaim) ||
        isGuestSeatClaimActive(guestClaim);

      const ownerLabel =
        occupantEntry?.userEmail ??
        (occupantEntry?.guestId
          ? `Guest ${occupantEntry.guestId.slice(-4)}`
          : isSupabaseSeatClaimActive(supabaseClaim)
            ? "Signed-in player"
            : guestClaim && isGuestSeatClaimActive(guestClaim)
              ? `Guest ${guestClaim.ownerGuestId.slice(-4)}`
              : undefined);

      return {
        playerId: player.id,
        name: player.name,
        occupied,
        ownerLabel,
        avatarEmoji:
          getSeatClaimFromCache(gameId, player.id)?.avatarEmoji ?? undefined,
        isAi: player.isAi,
        aiRuntime,
      };
    }),
  };
}

export function getGameSummary(gameId: string): GameSummary | null {
  const state = projectState(gameId);
  if (!state) return null;

  // Build spectator counts for this gameId
  let numSpectators = 0;
  for (const entry of playerRegistry.values()) {
    if (entry.gameId === gameId && entry.role === "spectator") {
      numSpectators += 1;
    }
  }

  const numSeats = state.players.length;
  const players = state.players.map((player) => {
    const aiRuntime =
      player.aiRuntime ??
      (player.isAi ? ("backend" as const) : ("none" as const));
    const key = seatKey(gameId, player.id);
    const isHumanSeated = seatAssignments.has(key);
    const hasSupabaseClaim = isSupabaseSeatClaimActive(
      getSeatClaimFromCache(gameId, player.id)
    );
    const hasGuestClaim = isGuestSeatClaimActive(
      getGuestSeatClaimFromCache(gameId, player.id)
    );
    return {
      id: player.id,
      name: player.name,
      occupied:
        isHumanSeated ||
        aiRuntime !== "none" ||
        hasSupabaseClaim ||
        hasGuestClaim,
    };
  });

  const numOccupiedSeats = players.filter((p) => p.occupied).length;
  const hasWinner = state.winner != null;
  const roomType = getRoomType(gameId);

  const rulesState = state.rulesState as { hasDealt?: boolean } | null;
  const hasDealt = rulesState?.hasDealt ?? false;
  const status = hasWinner ? "finished" : hasDealt ? "playing" : "waiting";

  return {
    gameId,
    rulesId: state.rulesId,
    gameName: state.gameName,
    numSeats,
    numOccupiedSeats,
    numSpectators,
    hasWinner,
    roomType,
    players,
    seed: state.seed,
    status,
    persistence: getGamePersistenceSummary(gameId),
  };
}

export function getActiveGameSummaries(): ActiveGameSummary[] {
  ensureDemoRooms();
  trimFinishedGamesNow();
  const gameIds = getAllGameIds();
  const activeGameIds = new Set(gameIds);

  for (const gameId of roomTypeByGameId.keys()) {
    if (!activeGameIds.has(gameId)) {
      roomTypeByGameId.delete(gameId);
    }
  }

  for (const gameId of persistenceByGameId.keys()) {
    if (!activeGameIds.has(gameId)) {
      persistenceByGameId.delete(gameId);
    }
  }

  for (const [rulesId, gameId] of demoRoomsByRulesId.entries()) {
    if (!activeGameIds.has(gameId)) {
      demoRoomsByRulesId.delete(rulesId);
    }
  }

  // Build spectator counts per gameId
  const spectatorCounts = new Map<string, number>();
  for (const entry of playerRegistry.values()) {
    if (entry.role === "spectator") {
      spectatorCounts.set(
        entry.gameId,
        (spectatorCounts.get(entry.gameId) ?? 0) + 1
      );
    }
  }

  const summaries: ActiveGameSummary[] = [];

  for (const gameId of gameIds) {
    const state = projectState(gameId);
    if (!state) continue;

    const numSeats = state.players.length;
    const numOccupiedSeats = state.players.reduce((count, player) => {
      const aiRuntime =
        player.aiRuntime ??
        (player.isAi ? ("backend" as const) : ("none" as const));
      const key = seatKey(gameId, player.id);
      const isHumanSeated = seatAssignments.has(key);
      return count + (isHumanSeated || aiRuntime !== "none" ? 1 : 0);
    }, 0);
    const numSpectators = spectatorCounts.get(gameId) ?? 0;
    const hasWinner = state.winner != null;
    const roomType = getRoomType(gameId);

    const rulesState = state.rulesState as { hasDealt?: boolean } | null;
    const hasDealt = rulesState?.hasDealt ?? false;
    const status = hasWinner ? "finished" : hasDealt ? "playing" : "waiting";

    summaries.push({
      gameId,
      rulesId: state.rulesId,
      numSeats,
      numOccupiedSeats,
      numSpectators,
      hasWinner,
      roomType,
      status,
      persistence: getGamePersistenceSummary(gameId),
    });
  }

  return summaries;
}

type HydrateGameFromSnapshotOptions = {
  gameId?: string;
  roomType: RoomType;
  markImportedHistory: boolean;
  markHistoricalAiUnavailable: boolean;
  persistence?: {
    storage: PersistedStorage;
    persistedAt?: string;
    hydratedFrom?: PersistedStorage;
    hydratedAt?: string;
  };
};

type HydrateGameFromSnapshotResult =
  | { ok: true; gameId: string; rulesId: string }
  | { ok: false; message: string };

function hydrateGameFromSnapshot(
  snapshot: GameSaveSnapshot,
  options: HydrateGameFromSnapshotOptions
): HydrateGameFromSnapshotResult {
  const rulesId = snapshot.initialState.rulesId;
  if (!GAME_PLUGINS[rulesId]) {
    return {
      ok: false,
      message: `Unsupported rules id in save: ${rulesId}`,
    };
  }

  const gameId = options.gameId ?? generateGameId();
  const initialState: GameState = {
    ...snapshot.initialState,
    gameId,
  };
  setRoomType(gameId, options.roomType);

  try {
    initGame(initialState);
  } catch (error) {
    roomTypeByGameId.delete(gameId);
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Failed to create game from save",
    };
  }

  try {
    let workingState = initialState;
    for (let idx = 0; idx < snapshot.events.length; idx += 1) {
      const persistedEvent = snapshot.events[idx];
      const { id: persistedId, ...persistedEventPayload } = persistedEvent;
      const event = GameEventSchema.parse({
        id: persistedId ?? idx + 1,
        gameId,
        ...persistedEventPayload,
      });
      workingState = applyEvent(workingState, event);
      appendEvent(gameId, event);
    }
    setExecutedIntents(gameId, snapshot.executedIntents ?? []);
    setImportedEventCount(
      gameId,
      options.markImportedHistory ? snapshot.events.length : 0
    );
    setImportedExecutedIntentCount(
      gameId,
      options.markImportedHistory ? (snapshot.executedIntents?.length ?? 0) : 0
    );
  } catch (error) {
    closeGame(gameId);
    roomTypeByGameId.delete(gameId);
    persistenceByGameId.delete(gameId);
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Failed to load save",
    };
  }

  if (options.roomType === "demo") {
    demoRoomsByRulesId.set(initialState.rulesId, gameId);
  }
  clearPendingClose(gameId);

  if (options.markHistoricalAiUnavailable) {
    markHistoricalAiTelemetryUnavailable(gameId);
  }

  if (options.persistence) {
    setGamePersistenceSummary(gameId, {
      storage: options.persistence.storage,
      ...(options.persistence.persistedAt
        ? { persistedAt: options.persistence.persistedAt }
        : {}),
      ...(options.persistence.hydratedFrom
        ? {
            hydratedFrom: options.persistence.hydratedFrom,
            ...(options.persistence.hydratedAt
              ? { hydratedAt: options.persistence.hydratedAt }
              : {}),
          }
        : {}),
    });
  }

  return {
    ok: true,
    gameId,
    rulesId: initialState.rulesId,
  };
}

export function restorePersistedGames(records: SupabasePersistedGameRecord[]): {
  restored: number;
  skipped: number;
  failed: number;
} {
  if (records.length === 0) {
    return { restored: 0, skipped: 0, failed: 0 };
  }

  const restoredDemoRules = new Set<string>();
  let restored = 0;
  let skipped = 0;
  let failed = 0;

  for (const record of records) {
    const roomType = normalizePersistedRoomType(record.roomType);
    const rulesId = record.snapshot.initialState.rulesId;
    if (roomType === "demo" && restoredDemoRules.has(rulesId)) {
      skipped += 1;
      continue;
    }

    if (projectState(record.gameId)) {
      skipped += 1;
      continue;
    }

    const hydratedAt = new Date().toISOString();
    const result = hydrateGameFromSnapshot(record.snapshot, {
      gameId: record.gameId,
      roomType,
      markImportedHistory: true,
      markHistoricalAiUnavailable: true,
      persistence: {
        storage: record.storage,
        persistedAt: record.persistedAt,
        hydratedFrom: record.storage,
        hydratedAt,
      },
    });

    if (!result.ok) {
      failed += 1;
      console.warn("[Autosave] Failed to restore persisted game", {
        gameId: record.gameId,
        roomType,
        message: result.message,
      });
      continue;
    }

    if (roomType === "demo") {
      restoredDemoRules.add(result.rulesId);
    }
    restored += 1;
  }

  return { restored, skipped, failed };
}

// Interface for local pre-validation results
interface ShortCircuitResult {
  shortCircuit: boolean;
  reason?: string;
}

// Local pre-validation to reject obviously invalid intents before calling the rules engine
function preValidateIntentLocally(
  state: GameState,
  intent: ClientIntent
): ShortCircuitResult {
  // Game over guard: if game already has a winner, reject any further moves
  if (state.winner != null) {
    return {
      shortCircuit: true,
      reason: "Game is already over; no further moves are allowed.",
    };
  }

  // Allow any seated player to kick off the game regardless of turn assignment
  if (!(intent.type === "action" && intent.action === "start-game")) {
    // Turn-based guard: if current player is set and doesn't match intent player
    if (state.currentPlayer && intent.playerId !== state.currentPlayer) {
      return {
        shortCircuit: true,
        reason: "It is not your turn.",
      };
    }
  }

  // Only apply move-specific validations to move intents
  if (intent.type === "move") {
    const cardIds =
      intent.cardIds ?? (intent.cardId !== undefined ? [intent.cardId] : []);
    if (cardIds.length === 0) {
      return {
        shortCircuit: true,
        reason: "Must specify either 'cardId' or a non-empty 'cardIds' array.",
      };
    }

    // No-op move guard: if moving from the same pile to the same pile without reordering
    // Allow reordering (same-pile moves with targetIndex) to reach the rules engine
    const hasTargetIndex =
      "targetIndex" in intent && typeof intent.targetIndex === "number";
    if (intent.fromPileId === intent.toPileId && !hasTargetIndex) {
      return {
        shortCircuit: true,
        reason:
          "Cannot move a card to the same pile. To reorder cards within a pile, drag them to a new position or use the arrow buttons.",
      };
    }

    // Card membership guard: verify the card actually exists in the source pile
    const fromPile = state.piles[intent.fromPileId];
    if (!fromPile) {
      return {
        shortCircuit: true,
        reason: `Pile '${intent.fromPileId}' does not exist.`,
      };
    }

    for (const cardId of cardIds) {
      if (!fromPile.cardIds.includes(cardId)) {
        return {
          shortCircuit: true,
          reason: "Card is not in the source pile.",
        };
      }
    }
  }

  // If we reach here, the intent passed all local pre-validation checks
  return {
    shortCircuit: false,
  };
}

function buildEventStatesForViewEvents(
  gameId: string,
  rawEvents: EngineEvent[],
  viewEvents: EngineEvent[]
): GameState[] | null {
  if (viewEvents.length === 0) {
    return null;
  }

  const allEvents = getEvents(gameId);
  if (allEvents.length < rawEvents.length) {
    return null;
  }

  const preEvents = allEvents.slice(0, allEvents.length - rawEvents.length);
  const preState = projectStateWithEvents(gameId, preEvents);
  if (!preState) {
    return null;
  }

  const states: GameState[] = [];
  let workingState = preState;
  const baseId = Date.now();

  for (let idx = 0; idx < viewEvents.length; idx += 1) {
    const engineEvent = viewEvents[idx];
    const gameEvent = {
      id: baseId + idx,
      gameId,
      playerId: null,
      ...engineEvent,
    } as GameEvent;

    workingState = applyEvent(workingState, gameEvent);
    states.push(workingState);
  }

  return states;
}

function broadcastState(
  io: Server,
  registry: Map<string, PlayerRegistryEntry>,
  state: GameState,
  lastEngineEvents?: EngineEvent[],
  lastAction?: LastAction
) {
  const viewSalt = getViewSalt(state.gameId);
  const roomId = state.gameId;
  const rawLastEngineEvents = lastEngineEvents ?? [];
  const viewEvents = rawLastEngineEvents.filter(
    (event) => event.type !== "fatal-error"
  );
  const eventStates = buildEventStatesForViewEvents(
    state.gameId,
    rawLastEngineEvents,
    viewEvents
  );
  io.in(roomId)
    .fetchSockets()
    .then((sockets) => {
      sockets.forEach((socket) => {
        // Race-safe: Verify registry entry still exists and is valid
        // Socket may have disconnected and been removed from registry
        // between fetchSockets() call and this iteration
        const info = registry.get(socket.id);
        if (!info || info.gameId !== roomId) {
          return;
        }

        const viewId =
          info.role === "player"
            ? info.playerId
            : info.isGodMode
              ? "__god__"
              : "__spectator__";
        const baseView = buildViewForPlayer(state, viewId, socket.id);

        const viewerKey = viewId;

        const legalIntents =
          info.role === "player"
            ? listLegalIntentsForView(state.gameId, info.playerId).map(
                (intent) => {
                  if (intent.type !== "move") return intent;
                  const baseIntent =
                    typeof intent.targetIndex === "number"
                      ? { targetIndex: intent.targetIndex }
                      : {};
                  if (intent.cardId !== undefined) {
                    return {
                      ...intent,
                      ...baseIntent,
                      cardId: toViewCardId(
                        intent.cardId,
                        viewSalt,
                        info.playerId
                      ),
                    };
                  }
                  if (intent.cardIds !== undefined) {
                    return {
                      ...intent,
                      ...baseIntent,
                      cardIds: intent.cardIds.map((id) =>
                        toViewCardId(id, viewSalt, info.playerId)
                      ),
                    };
                  }
                  return baseIntent ? { ...intent, ...baseIntent } : intent;
                }
              )
            : undefined;
        const view =
          info.role === "player"
            ? applyLegalActionsToView(baseView, legalIntents)
            : baseView;

        const lastFatalErrors =
          rawLastEngineEvents.filter((event) => event.type === "fatal-error") ??
          [];

        let personalizedLastAction = lastAction;
        if (
          lastAction &&
          lastAction.action === "move" &&
          lastAction.cardId !== undefined
        ) {
          personalizedLastAction = {
            id: lastAction.id,
            playerId: lastAction.playerId,
            action: lastAction.action,
            label: findMoveLabel(
              state,
              {
                type: "move",
                cardId: lastAction.cardId,
                fromPileId: lastAction.fromPileId || "",
                toPileId: lastAction.toPileId || "",
                gameId: state.gameId,
                playerId: lastAction.playerId,
              },
              viewId
            ),
          };
        }

        const lastViewEvents = viewEvents.map((event, index) => {
          if (event.type === "move-cards") {
            const eventState = eventStates?.[index];
            const toPile = eventState?.piles[event.toPileId];
            const pileVisible =
              eventState && toPile
                ? isPileVisibleToPlayer(toPile, viewId)
                : false;
            const cardViews = eventState
              ? event.cardIds
                  .map((id) => {
                    const card = eventState.cards[id];
                    if (!card) {
                      return null;
                    }
                    return {
                      id: toViewCardId(id, viewSalt, viewerKey),
                      label: pileVisible ? card.label : undefined,
                      rank: pileVisible ? card.rank : undefined,
                      suit: pileVisible ? card.suit : undefined,
                      faceDown: !pileVisible,
                      rotationDeg: eventState.cardVisuals?.[id]?.rotationDeg,
                    };
                  })
                  .filter(
                    (cardView): cardView is NonNullable<typeof cardView> =>
                      cardView !== null
                  )
              : [];

            return {
              ...event,
              cardIds: event.cardIds.map((id) =>
                toViewCardId(id, viewSalt, viewerKey)
              ),
              ...(cardViews.length > 0 ? { cardViews } : {}),
            };
          }

          if (event.type === "set-card-visuals") {
            const visuals: Record<string, { rotationDeg?: number }> = {};
            for (const [engineIdKey, visual] of Object.entries(event.visuals)) {
              const engineId = Number(engineIdKey);
              if (!Number.isInteger(engineId)) {
                continue;
              }
              visuals[String(toViewCardId(engineId, viewSalt, viewerKey))] =
                visual;
            }
            return {
              ...event,
              visuals,
            };
          }

          return event;
        });

        const stateVersion = getEvents(state.gameId).length;
        const payload = {
          ...view,
          stateVersion,
          ...(legalIntents && legalIntents.length > 0 ? { legalIntents } : {}),
          ...(lastViewEvents.length > 0 ? { lastViewEvents } : {}),
          ...(lastFatalErrors.length > 0 ? { lastFatalErrors } : {}),
          ...(info.isGodMode && lastEngineEvents && lastEngineEvents.length > 0
            ? { lastEngineEvents }
            : {}),
          ...(personalizedLastAction
            ? { lastAction: personalizedLastAction }
            : {}),
        };

        // Emit with error handling in case socket became invalid during iteration
        try {
          socket.emit("game:state", payload);
        } catch (error) {
          // Use separate arguments to prevent format string injection
          console.error(
            "Failed to emit state to socket in room:",
            { socketId: socket.id, roomId },
            error
          );
        }
      });
    })
    .catch((error) => {
      console.error("Failed to broadcast state", error);
    });
}

function canApplyGameEvent(
  state: GameState,
  event: GameEvent
): { ok: boolean; reason?: string } {
  if (event.type === "set-pile-visibility") {
    const pile = state.piles[event.pileId];
    if (!pile) {
      return {
        ok: false,
        reason: `Pile "${event.pileId}" missing when applying set-pile-visibility.`,
      };
    }
    return { ok: true };
  }

  if (event.type !== "move-cards") {
    return { ok: true };
  }

  const fromPile = state.piles[event.fromPileId];
  if (!fromPile) {
    return {
      ok: false,
      reason: `Pile "${event.fromPileId}" missing when applying dealer event.`,
    };
  }

  const missingCards = event.cardIds.filter(
    (cardId) => !fromPile.cardIds.includes(cardId)
  );

  if (missingCards.length > 0) {
    return {
      ok: false,
      reason: `Attempted to move cards [${missingCards.join(
        ", "
      )}] from pile "${event.fromPileId}" but they are not present`,
    };
  }

  return { ok: true };
}

const sendSeatStatus = (socket: Socket, gameId: string) => {
  const payload = buildSeatStatusPayload(gameId, seatAssignments);
  socket.emit("game:seats", payload);
};

const broadcastSeatStatus = (gameId: string) => {
  if (!globalIoServer) {
    console.error("Global IO server not initialized for seat broadcast");
    return;
  }
  const payload = buildSeatStatusPayload(gameId, seatAssignments);
  globalIoServer.to(gameId).emit("game:seats", payload);
};

export function initSocket(io: Server) {
  // Store the server instance globally so AI system and other module functions can broadcast
  globalIoServer = io;

  initAiLogIo(io);

  io.use(async (socket, next) => {
    const authPayload = socket.handshake.auth as {
      token?: unknown;
      guestId?: unknown;
    } | null;

    const guestId = normalizeGuestId(authPayload?.guestId);
    if (guestId) {
      (
        socket.data as { guestId?: string | null; userId?: string | null }
      ).guestId = guestId;
    }

    const token =
      authPayload && typeof authPayload.token === "string"
        ? authPayload.token
        : "";
    if (!token.trim()) {
      next();
      return;
    }

    if (!isSupabaseIdentityEnabled()) {
      next();
      return;
    }

    const verified = await verifySupabaseAccessToken(token);
    if (!verified) {
      next(new Error("Invalid authentication token"));
      return;
    }

    (
      socket.data as {
        userId?: string;
        userEmail?: string | null;
      }
    ).userId = verified.userId;
    (
      socket.data as {
        userId?: string;
        userEmail?: string | null;
      }
    ).userEmail = verified.email;
    next();
  });

  if (!seatClaimCleanupTimer) {
    seatClaimCleanupTimer = setInterval(() => {
      void runSeatClaimCleanup();
    }, getSeatClaimCleanupIntervalMs());
  }

  const reportEngineWarning = (
    gameId: string,
    message: string,
    error?: unknown
  ) => {
    if (error) {
      console.error(message, error);
    } else {
      console.error(message);
    }

    if (!gameId) {
      return;
    }

    io.to(gameId).emit("game:status", {
      message,
      tone: "warning" as const,
      source: "engine" as const,
    });
  };

  io.on("connection", (socket: Socket) => {
    const warmupWarning = getWarmupWarningMessage();
    if (warmupWarning) {
      socket.emit("game:status", {
        message: warmupWarning,
        tone: "warning" as const,
        source: "ai" as const,
      });
    }

    socket.on("auth:refresh", async (raw: unknown) => {
      if (!isSupabaseIdentityEnabled()) return;

      const existingUserId = getSocketUserId(socket);
      if (!existingUserId) {
        // Allow guest -> authenticated upgrade on an existing socket.
      }

      const payload = raw as { token?: unknown; guestId?: unknown } | null;
      const token =
        payload && typeof payload.token === "string" ? payload.token : "";
      const refreshedGuestId = normalizeGuestId(payload?.guestId);
      if (refreshedGuestId) {
        (socket.data as { guestId?: string | null }).guestId = refreshedGuestId;
      }

      if (!token.trim()) {
        // Allow authenticated -> guest downgrade (e.g., sign-out on the client).
        const previousUserId = getSocketUserId(socket);
        const entry = playerRegistry.get(socket.id);
        if (
          previousUserId &&
          entry?.role === "player" &&
          isSupabaseIdentityEnabled()
        ) {
          await ensureSeatClaimsLoadedForGame(entry.gameId);
          const claim = getSeatClaimFromCache(entry.gameId, entry.playerId);
          if (claim && claim.ownerUserId === previousUserId) {
            const released = await releaseSeatOwnership({
              gameId: entry.gameId,
              seatId: entry.playerId,
              requesterUserId: previousUserId,
              ownerUserId: claim.ownerUserId,
            });
            if (released) {
              removeSeatClaimFromCache(entry.gameId, entry.playerId);
            }
          }
        }

        (socket.data as { userId?: string | null }).userId = null;
        (socket.data as { userEmail?: string | null }).userEmail = null;
        if (entry) {
          playerRegistry.set(socket.id, {
            ...entry,
            userId: null,
            userEmail: null,
            guestId: getSocketGuestId(socket),
          });
          broadcastSeatStatus(entry.gameId);
        }
        return;
      }

      const now = Date.now();
      const lastRefresh = authRefreshTimestamps.get(socket.id) ?? 0;
      if (now - lastRefresh < AUTH_REFRESH_COOLDOWN_MS) {
        socket.emit("game:error", {
          message: "Token refresh too frequent",
          source: "app",
        });
        return;
      }
      authRefreshTimestamps.set(socket.id, now);

      const verified = await verifySupabaseAccessToken(token);
      if (!verified) {
        socket.emit("game:error", {
          message: "Authentication refresh failed",
          source: "app",
        });
        socket.disconnect(true);
        return;
      }

      if (existingUserId && existingUserId !== verified.userId) {
        socket.emit("game:error", {
          message: "Authentication refresh mismatch",
          source: "app",
        });
        socket.disconnect(true);
        return;
      }

      (
        socket.data as {
          userId?: string;
          userEmail?: string | null;
        }
      ).userId = verified.userId;
      (
        socket.data as {
          userId?: string;
          userEmail?: string | null;
        }
      ).userEmail = verified.email;
      const entry = playerRegistry.get(socket.id);
      if (entry) {
        playerRegistry.set(socket.id, {
          ...entry,
          userId: verified.userId,
          userEmail: verified.email,
          guestId: getSocketGuestId(socket),
        });
        broadcastSeatStatus(entry.gameId);
      }
    });

    socket.on("game:leave", async () => {
      const watchedGameId = watchRegistry.get(socket.id);
      if (watchedGameId) {
        stopWatching(socket);
      }

      const info = playerRegistry.get(socket.id);
      if (!info) {
        if (watchedGameId) {
          const clearedSponsoredAi = clearSponsoredAiForSocket(
            watchedGameId,
            socket.id
          );
          if (clearedSponsoredAi) {
            broadcastStateToGame(watchedGameId);
            broadcastSeatStatus(watchedGameId);
          }
          maybeCloseAbandonedGame(io, watchedGameId);
        }
        return;
      }

      const { gameId, playerId, role } = info;
      const clearedSponsoredAi = clearSponsoredAiForSocket(gameId, socket.id);

      if (role === "player") {
        const key = seatKey(gameId, playerId);
        if (seatAssignments.get(key) === socket.id) {
          seatAssignments.delete(key);
        }
        await markSeatClaimDisconnectedForEntry(info);
      }

      // Remove this socket's registry entry and leave the room
      playerRegistry.delete(socket.id);
      socket.leave(gameId);

      if (maybeCloseAbandonedGame(io, gameId)) {
        return;
      }

      if (clearedSponsoredAi) {
        broadcastStateToGame(gameId);
      }
      broadcastSeatStatus(gameId);
    });

    socket.on("disconnect", () => {
      authRefreshTimestamps.delete(socket.id);
      const watchedGameId = watchRegistry.get(socket.id);
      if (watchedGameId) {
        watchRegistry.delete(socket.id);
      }

      for (const gameId of getAllGameIds()) {
        const snapshot = projectState(gameId);
        if (!snapshot) continue;

        let changed = false;
        for (const player of snapshot.players) {
          const aiRuntime = getAiRuntime(player);
          if (
            aiRuntime === "frontend" &&
            player.aiSponsorConnectionId === socket.id
          ) {
            setSeatRuntime(gameId, player.id, "none", null);
            changed = true;
          }
        }

        if (changed) {
          broadcastStateToGame(gameId);
          broadcastSeatStatus(gameId);
        }
      }

      const info = playerRegistry.get(socket.id);
      const departedGameId = info?.gameId;
      if (info?.role === "player") {
        const seatKeyValue = seatKey(info.gameId, info.playerId);
        if (seatAssignments.get(seatKeyValue) === socket.id) {
          seatAssignments.delete(seatKeyValue);
        }
        void markSeatClaimDisconnectedForEntry(info);
      }
      playerRegistry.delete(socket.id);

      let shouldBroadcastSeats = true;
      if (departedGameId) {
        shouldBroadcastSeats = !maybeCloseAbandonedGame(io, departedGameId);
      }
      if (departedGameId && shouldBroadcastSeats) {
        broadcastSeatStatus(departedGameId);
      }
      if (!departedGameId && watchedGameId) {
        maybeCloseAbandonedGame(io, watchedGameId);
      }

      // Clean up rate limit entry for this socket
      rateLimitMap.delete(socket.id);
    });

    socket.on(
      "game:start",
      async (requestedGameType: string, seed?: string, options?: unknown) => {
        try {
          // Use Zod validation instead of manual type checking
          const opts = StartGameOptionsSchema.parse(options ?? {});
          const isDemoRoomRequest = opts?.dedicatedLobby === true;
          const isPublicRoomRequest = opts?.publicRoom === true;

          if (isDemoRoomRequest) {
            const demoGameId = ensureDemoRoom(requestedGameType);
            if (demoGameId) {
              const demoState = projectState(demoGameId);
              if (demoState) {
                if (opts.resetDedicated) {
                  resetGame(demoGameId);
                  broadcastStateToGame(demoGameId);
                }

                await setHostUserIfMissing(demoGameId, getSocketUserId(socket));
                await ensureSeatClaimsLoadedForGame(demoGameId);
                socket.join(demoGameId);
                sendSeatStatus(socket, demoGameId);
                socket.emit("game:start:success", {
                  gameId: demoGameId,
                  rulesId: requestedGameType,
                  seed:
                    typeof demoState.seed === "string"
                      ? demoState.seed
                      : undefined,
                });
                return;
              }
            }
          }

          const initialState = loadAndValidateGameConfig(
            requestedGameType,
            seed
          );

          // Generate unique gameId for this instance
          const gameId = generateGameId();

          // Override gameId in initialState
          const stateForGame: GameState = {
            ...initialState,
            gameId,
          };
          const roomType: RoomType = isDemoRoomRequest
            ? "demo"
            : isPublicRoomRequest
              ? "public"
              : "private";
          setRoomType(gameId, roomType);

          try {
            initGame(stateForGame);
          } catch (err) {
            roomTypeByGameId.delete(gameId);
            if (
              err instanceof Error &&
              err.message.includes("Max active games")
            ) {
              socket.emit("game:status", {
                gameId: stateForGame.gameId,
                message: err.message,
                tone: "warning",
                source: "app",
              });
              return;
            }
            throw err;
          }
          if (roomType === "demo") {
            demoRoomsByRulesId.set(requestedGameType, gameId);
          }
          await setHostUserIfMissing(gameId, getSocketUserId(socket));

          socket.emit("game:start:success", {
            gameId,
            rulesId: stateForGame.rulesId,
            seed: stateForGame.seed,
          });

          // Join the creator to the game room; they may later choose a player seat
          socket.join(gameId);

          // Send initial seat status for this game
          sendSeatStatus(socket, gameId);
        } catch (error) {
          console.error("Error starting game", error);
          socket.emit("game:error", {
            message: "Failed to start game",
            source: "app",
          });
        }
      }
    );

    socket.on(
      "game:save-export",
      (
        payload: { gameId?: unknown } | undefined,
        cb?: GameSaveExportCallback
      ) => {
        const respondError = (message: string) => {
          cb?.({ ok: false, message });
          if (!cb) {
            socket.emit("game:error", { message, source: "app" });
          }
        };

        const gameId = payload?.gameId;
        if (typeof gameId !== "string" || gameId.trim() === "") {
          respondError("Invalid save export payload");
          return;
        }

        if (!hasGameAccess(socket.id, gameId)) {
          respondError("You are not joined to this game");
          return;
        }

        const snapshot = buildGameSaveSnapshot(gameId);
        if (!snapshot) {
          respondError("Game not found");
          return;
        }

        const parsed = GameSaveSnapshotSchema.safeParse(snapshot);
        if (!parsed.success) {
          console.error(
            "[game:save-export] Generated snapshot failed schema validation",
            parsed.error.flatten()
          );
          respondError("Failed to export save");
          return;
        }

        cb?.({ ok: true, snapshot: parsed.data });
      }
    );

    socket.on(
      "game:save-import",
      async (rawSnapshot: unknown, cb?: GameSaveImportCallback) => {
        const respondError = (message: string) => {
          cb?.({ ok: false, message });
          if (!cb) {
            socket.emit("game:error", { message, source: "app" });
          }
        };

        if (playerRegistry.has(socket.id) || watchRegistry.has(socket.id)) {
          respondError("Leave the current game before loading a save");
          return;
        }

        const parsed = parseSaveSnapshotForImport(rawSnapshot);
        if (!parsed.ok) {
          respondError(parsed.message);
          return;
        }

        const {
          snapshot,
          mode: parseMode,
          warnings: parseWarnings,
        } = parsed.parsed;
        const rulesId = snapshot.initialState.rulesId;
        if (!GAME_PLUGINS[rulesId]) {
          respondError(`Unsupported rules id in save: ${rulesId}`);
          return;
        }

        const hydrateResult = hydrateGameFromSnapshot(snapshot, {
          roomType: "private",
          markImportedHistory: true,
          markHistoricalAiUnavailable: true,
        });
        if (!hydrateResult.ok) {
          respondError(`Failed to load save: ${hydrateResult.message}`);
          return;
        }

        const { gameId } = hydrateResult;
        const initialState: GameState = {
          ...snapshot.initialState,
          gameId,
        };

        await setHostUserIfMissing(gameId, getSocketUserId(socket));
        await ensureSeatClaimsLoadedForGame(gameId);
        socket.join(gameId);
        sendSeatStatus(socket, gameId);
        socket.emit("game:start:success", {
          gameId,
          rulesId: initialState.rulesId,
          seed: initialState.seed,
        });

        if (parseMode === "lax") {
          socket.emit("game:status", {
            message: "Save loaded with best-effort recovery mode.",
            tone: "warning",
            source: "engine",
          });
        }
        for (const warning of parseWarnings) {
          socket.emit("game:status", {
            message: warning,
            tone: "warning",
            source: "engine",
          });
        }

        // Resume backend AI flow immediately after import when the imported
        // state is on a backend-controlled seat's turn.
        maybeScheduleAiTurn(gameId, broadcastStateToGame);

        cb?.({ ok: true, gameId, rulesId: initialState.rulesId });
      }
    );

    type WatchGamePayload = {
      gameId: string;
    };

    socket.on("game:watch", async (raw: unknown) => {
      let payload: WatchGamePayload;
      try {
        const r = raw as { gameId?: unknown };
        if (!r || typeof r !== "object" || typeof r.gameId !== "string") {
          throw new Error("Invalid watch payload");
        }
        payload = raw as WatchGamePayload;
      } catch {
        socket.emit("game:error", {
          message: "Invalid watch payload",
          source: "app",
        });
        return;
      }

      const { gameId } = payload;
      const state = projectState(gameId);
      if (!state) {
        socket.emit("game:error", {
          message: "Game not found",
          source: "app",
        });
        return;
      }

      stopWatching(socket);
      await setHostUserIfMissing(gameId, getSocketUserId(socket));
      await ensureSeatClaimsLoadedForGame(gameId);
      watchRegistry.set(socket.id, gameId);
      socket.join(gameId);
      sendSeatStatus(socket, gameId);
      maybeScheduleAiTurn(gameId, broadcastStateToGame);
    });

    type JoinGamePayload = {
      gameId: string;
      playerId: string;
      role?: PlayerRole; // "player" | "spectator"
      isGodMode?: boolean;
    };

    socket.on("game:join", async (raw: unknown) => {
      let payload: JoinGamePayload;
      try {
        // simple runtime validation
        const r = raw as {
          gameId?: unknown;
          playerId?: unknown;
          role?: unknown;
          isGodMode?: unknown;
        };
        if (
          !r ||
          typeof r !== "object" ||
          typeof r.gameId !== "string" ||
          typeof r.playerId !== "string"
        ) {
          throw new Error("Invalid join payload");
        }
        if (r.isGodMode != null && typeof r.isGodMode !== "boolean") {
          throw new Error("Invalid join payload");
        }
        payload = raw as JoinGamePayload;
      } catch {
        socket.emit("game:error", {
          message: "Invalid join payload",
          source: "app",
        });
        return;
      }

      const { gameId, playerId } = payload;
      const role: PlayerRole = payload.role ?? "player";
      const isGodMode = role === "spectator" && payload.isGodMode === true;
      const socketUserId = getSocketUserId(socket);
      const socketUserEmail = getSocketUserEmail(socket);
      const socketGuestId = getSocketGuestId(socket);

      const state = projectState(gameId);
      if (!state) {
        socket.emit("game:error", {
          message: "Game not found",
          source: "app",
        });
        return;
      }

      clearPendingClose(gameId);
      await setHostUserIfMissing(gameId, socketUserId);
      await ensureSeatClaimsLoadedForGame(gameId);

      const existing = playerRegistry.get(socket.id);
      const oldGameId = existing?.gameId;
      const changedSeatOrRole =
        !!existing &&
        (existing.gameId !== gameId ||
          existing.playerId !== playerId ||
          existing.role !== role);

      let claimedSeat: SeatClaimRecord | null = null;
      let claimedGuestSeat: GuestSeatClaimRecord | null = null;
      const newSeatKey = seatKey(gameId, playerId);

      if (role === "player") {
        const seat = state.players.find((player) => player.id === playerId);
        if (!seat) {
          socket.emit("game:error", {
            message: "Player seat not recognized",
            source: "app",
          });
          return;
        }

        const seatRuntime =
          seat.aiRuntime ??
          (seat.isAi ? ("backend" as const) : ("none" as const));
        if (seatRuntime !== "none") {
          socket.emit("game:error", {
            message: "Seat is controlled by AI; disable AI to take this seat",
            source: "app",
          });
          sendSeatStatus(socket, gameId);
          return;
        }

        if (isSupabaseIdentityEnabled() && !socketUserId && !socketGuestId) {
          socket.emit("game:error", {
            message: "Identity missing. Reload the page and try again.",
            source: "app",
          });
          return;
        }

        if (isSupabaseIdentityEnabled() && socketUserId) {
          const claimResult = await claimSeatOwnership({
            gameId,
            seatId: playerId,
            userId: socketUserId,
          });
          if (!claimResult.ok) {
            socket.emit("game:error", {
              message:
                claimResult.reason === "owned-by-other"
                  ? "Seat is owned by another player"
                  : "Failed to claim seat",
              source: "app",
            });
            sendSeatStatus(socket, gameId);
            return;
          }
          claimedSeat = claimResult.claim;
          setSeatClaimInCache(claimResult.claim);
          removeGuestSeatClaimFromCache(gameId, playerId);
        } else if (socketGuestId) {
          const claimResult = claimGuestSeatOwnership({
            gameId,
            seatId: playerId,
            guestId: socketGuestId,
          });
          if (!claimResult.ok) {
            socket.emit("game:error", {
              message: "Seat is owned by another guest",
              source: "app",
            });
            sendSeatStatus(socket, gameId);
            return;
          }
          claimedGuestSeat = claimResult.claim;
        }

        // Player occupies their logical seat (one per playerId per game)
        const currentOccupantId = seatAssignments.get(newSeatKey);

        if (currentOccupantId && currentOccupantId !== socket.id) {
          // If the seat is already taken, we allow the new socket to "reclaim" it.
          // This handles cases where a user refreshes their browser and their old
          // socket hasn't timed out yet.
          const displaced = playerRegistry.get(currentOccupantId);
          const oldSocket = io.sockets.sockets.get(currentOccupantId);
          if (oldSocket) {
            oldSocket.leave(gameId);
          }
          if (displaced?.role === "player") {
            const displacedKey = seatKey(displaced.gameId, displaced.playerId);
            if (seatAssignments.get(displacedKey) === currentOccupantId) {
              seatAssignments.delete(displacedKey);
            }
            void markSeatClaimDisconnectedForEntry(displaced);
          }
          playerRegistry.delete(currentOccupantId);
          io.to(currentOccupantId).emit("game:status", {
            message: "Seat session replaced by a newer connection.",
            tone: "warning",
            source: "app",
          });
        }
      }

      // Ensure socket joins the correct room
      socket.join(gameId);
      stopWatching(socket, gameId);

      // Clear any previous seat assignment for this socket
      if (existing?.role === "player") {
        const previousKey = seatKey(existing.gameId, existing.playerId);
        if (seatAssignments.get(previousKey) === socket.id) {
          seatAssignments.delete(previousKey);
        }
      }
      if (existing && changedSeatOrRole && existing.role === "player") {
        await markSeatClaimDisconnectedForEntry(existing);
      }

      // Register this socket
      playerRegistry.set(socket.id, {
        gameId,
        playerId,
        role,
        isGodMode,
        userId: socketUserId,
        userEmail: socketUserEmail,
        guestId: socketGuestId,
      });

      if (role === "player") {
        seatAssignments.set(newSeatKey, socket.id);
        if (claimedSeat) {
          setSeatClaimInCache(claimedSeat);
        }
        if (claimedGuestSeat) {
          setGuestSeatClaimInCache(claimedGuestSeat);
        }
      }

      // If we moved from a different game, notify that room of the vacancy
      if (oldGameId && oldGameId !== gameId) {
        broadcastSeatStatus(oldGameId);
      }

      // Spectators do NOT occupy any seat; they just join the room.
      const latestState = projectState(gameId);
      if (!latestState) {
        socket.emit("game:error", {
          message: "Game not found",
          source: "app",
        });
        return;
      }

      const viewId =
        role === "player" ? playerId : isGodMode ? "__god__" : "__spectator__";
      const baseView = buildViewForPlayer(latestState, viewId, socket.id);

      const viewSalt = getViewSalt(gameId);
      const legalIntents =
        role === "player"
          ? listLegalIntentsForView(gameId, playerId).map((intent) => {
              if (intent.type !== "move") return intent;
              if (intent.cardId !== undefined) {
                return {
                  ...intent,
                  cardId: toViewCardId(intent.cardId, viewSalt, playerId),
                };
              }
              if (intent.cardIds !== undefined) {
                return {
                  ...intent,
                  cardIds: intent.cardIds.map((id) =>
                    toViewCardId(id, viewSalt, playerId)
                  ),
                };
              }
              return intent;
            })
          : undefined;
      const view =
        role === "player"
          ? applyLegalActionsToView(baseView, legalIntents)
          : baseView;

      socket.emit("game:state", {
        ...view,
        ...(legalIntents && legalIntents.length > 0 ? { legalIntents } : {}),
      });
      broadcastSeatStatus(gameId);
      maybeScheduleAiTurn(gameId, broadcastStateToGame);
    });

    interface ReleaseSeatPayload {
      gameId: string;
      seatId: string;
      force?: boolean;
    }

    socket.on("game:release-seat", async (payload: ReleaseSeatPayload) => {
      const { gameId, seatId, force } = payload ?? ({} as ReleaseSeatPayload);
      if (typeof gameId !== "string" || typeof seatId !== "string") {
        socket.emit("game:error", {
          message: "Invalid seat release payload",
          source: "app",
        });
        return;
      }
      if (!hasGameAccess(socket.id, gameId)) {
        socket.emit("game:error", {
          message: "You are not joined to this game",
          source: "app",
        });
        return;
      }
      const requesterUserId = getSocketUserId(socket);
      const requesterGuestId = getSocketGuestId(socket);

      await ensureSeatClaimsLoadedForGame(gameId);
      const isForce = force === true;
      const hostUser =
        requesterUserId == null
          ? false
          : await isHostUserForGame(gameId, requesterUserId);
      if (isForce && !hostUser) {
        socket.emit("game:error", {
          message: "Only the host can force-release seats",
          source: "app",
        });
        return;
      }

      const claim = getSeatClaimFromCache(gameId, seatId);
      const guestClaim = getGuestSeatClaimFromCache(gameId, seatId);
      const registryEntry = playerRegistry.get(socket.id);
      const ownsSeatByConnection =
        registryEntry?.role === "player" &&
        registryEntry.gameId === gameId &&
        registryEntry.playerId === seatId;
      if (!isForce && !claim && !guestClaim && !ownsSeatByConnection) {
        socket.emit("game:error", {
          message: "Only the seat owner can release this seat",
          source: "app",
        });
        return;
      }
      if (
        claim &&
        !isForce &&
        (!requesterUserId || claim.ownerUserId !== requesterUserId)
      ) {
        socket.emit("game:error", {
          message: "Only the seat owner can release this seat",
          source: "app",
        });
        return;
      }
      if (
        guestClaim &&
        !isForce &&
        (!requesterGuestId || guestClaim.ownerGuestId !== requesterGuestId)
      ) {
        socket.emit("game:error", {
          message: "Only the seat owner can release this seat",
          source: "app",
        });
        return;
      }

      if (claim && !requesterUserId && !isForce) {
        socket.emit("game:error", {
          message: "Failed to release seat",
          source: "app",
        });
        return;
      }

      if (claim) {
        const released = await releaseSeatOwnership({
          gameId,
          seatId,
          requesterUserId: requesterUserId ?? "",
          ownerUserId: claim.ownerUserId,
          force: isForce,
        });
        if (!released) {
          socket.emit("game:error", {
            message: "Failed to release seat",
            source: "app",
          });
          return;
        }
      }

      if (guestClaim) {
        const releasedGuest = releaseGuestSeatOwnership({
          gameId,
          seatId,
          requesterGuestId,
          force: isForce,
        });
        if (!releasedGuest) {
          socket.emit("game:error", {
            message: "Failed to release seat",
            source: "app",
          });
          return;
        }
      }

      removeSeatClaimFromCache(gameId, seatId);
      removeGuestSeatClaimFromCache(gameId, seatId);
      const assignmentKey = seatKey(gameId, seatId);
      const occupantSocketId = seatAssignments.get(assignmentKey);
      if (occupantSocketId) {
        seatAssignments.delete(assignmentKey);
        const occupantEntry = playerRegistry.get(occupantSocketId);
        if (
          occupantEntry &&
          occupantEntry.role === "player" &&
          occupantEntry.gameId === gameId &&
          occupantEntry.playerId === seatId
        ) {
          playerRegistry.set(occupantSocketId, {
            ...occupantEntry,
            role: "spectator",
            isGodMode: false,
          });

          const occupantSocket = io.sockets.sockets.get(occupantSocketId);
          const snapshot = projectState(gameId);
          if (occupantSocket && snapshot) {
            const spectatorView = buildViewForPlayer(
              snapshot,
              "__spectator__",
              occupantSocketId
            );
            occupantSocket.emit("game:state", spectatorView);
            occupantSocket.emit("game:status", {
              message: isForce
                ? "Host released your seat."
                : "Seat released. You are now spectating.",
              tone: "warning",
              source: "app",
            });
          }
        }
      }

      broadcastSeatStatus(gameId);
      broadcastStateToGame(gameId);
    });

    interface SetSeatAvatarPayload {
      gameId: string;
      seatId: string;
      avatarEmoji?: string | null;
    }

    socket.on(
      "game:set-avatar-emoji",
      async (payload: SetSeatAvatarPayload | undefined) => {
        const { gameId, seatId, avatarEmoji } = payload ?? {};
        if (typeof gameId !== "string" || typeof seatId !== "string") {
          socket.emit("game:error", {
            message: "Invalid avatar payload",
            source: "app",
          });
          return;
        }

        const registryEntry = playerRegistry.get(socket.id);
        if (
          !registryEntry ||
          registryEntry.gameId !== gameId ||
          registryEntry.role !== "player" ||
          registryEntry.playerId !== seatId
        ) {
          socket.emit("game:error", {
            message: "You can only change your current seat avatar",
            source: "app",
          });
          return;
        }

        if (!isSupabaseIdentityEnabled()) {
          socket.emit("game:error", {
            message: "Avatar updates require identity mode",
            source: "app",
          });
          return;
        }

        const userId = getSocketUserId(socket);
        if (!userId) {
          socket.emit("game:error", {
            message: "Authentication required",
            source: "app",
          });
          return;
        }

        await ensureSeatClaimsLoadedForGame(gameId);
        const claim = getSeatClaimFromCache(gameId, seatId);
        if (!claim || claim.ownerUserId !== userId) {
          socket.emit("game:error", {
            message: "Seat ownership required to update avatar",
            source: "app",
          });
          return;
        }

        const normalizedAvatar = normalizeAvatarEmoji(avatarEmoji);
        const profileAvatar = await upsertUserProfileAvatar(
          userId,
          normalizedAvatar
        );
        const updatedClaim = await setSeatClaimAvatarEmoji({
          gameId,
          seatId,
          userId,
          avatarEmoji: profileAvatar,
        });
        if (!updatedClaim) {
          socket.emit("game:error", {
            message: "Failed to update avatar",
            source: "app",
          });
          return;
        }

        setSeatClaimInCache(updatedClaim);
        broadcastSeatStatus(gameId);
        broadcastStateToGame(gameId);
      }
    );

    // Rate limiting configuration
    const rateLimitMap = new Map<string, number[]>();
    const RATE_LIMIT_WINDOW_MS = 1000; // 1 second window
    const MAX_INTENTS_PER_WINDOW = 10;

    const checkRateLimit = (socketId: string): boolean => {
      const now = Date.now();
      const timestamps = rateLimitMap.get(socketId) ?? [];

      // Remove timestamps outside the current window
      const validTimestamps = timestamps.filter(
        (ts) => now - ts < RATE_LIMIT_WINDOW_MS
      );

      // Check if we're under the limit
      if (validTimestamps.length >= MAX_INTENTS_PER_WINDOW) {
        return false; // Rate limit exceeded
      }

      // Add the current timestamp and store back
      validTimestamps.push(now);
      rateLimitMap.set(socketId, validTimestamps);

      return true; // Within limit
    };

    socket.on("game:intent", (raw: unknown) => {
      if (!checkRateLimit(socket.id)) {
        socket.emit("game:status", {
          message: "Rate limit exceeded. Please slow down your moves.",
          tone: "warning" as const,
          source: "app" as const,
        });
        return;
      }

      let intent: ClientIntent;
      try {
        intent = ClientIntentSchema.parse(raw);
      } catch {
        socket.emit("game:error", {
          message: "Invalid intent payload",
          source: "app",
        });
        return;
      }

      const registryEntry = playerRegistry.get(socket.id);
      if (!registryEntry) {
        socket.emit("game:error", {
          message: "You are not joined to any game",
          source: "app",
        });
        return;
      }

      if (registryEntry.gameId !== intent.gameId) {
        socket.emit("game:error", {
          message: "Intent game mismatch",
          source: "app",
        });
        return;
      }

      const isStartGameAction =
        intent.type === "action" && intent.action === "start-game";

      if (registryEntry.role !== "player") {
        if (!isStartGameAction) {
          socket.emit("game:error", {
            message: "Spectators cannot make moves",
            source: "app",
          });
          return;
        }
      }

      const gameId = intent.gameId;

      enqueueGameWork(gameId, async () => {
        try {
          const state = projectState(gameId);
          if (!state) {
            socket.emit("game:error", {
              message: "Game not found",
              source: "app",
            });
            return;
          }

          const isSpectator = registryEntry.role !== "player";

          const effectiveIntent: ClientIntent = (() => {
            if (!isStartGameAction || !isSpectator) {
              return intent;
            }

            const fallbackPlayerId =
              state.currentPlayer ?? state.players[0]?.id;
            return fallbackPlayerId
              ? { ...intent, playerId: fallbackPlayerId }
              : intent;
          })();

          if (isStartGameAction) {
            // Use extracted utility function for spectator validation
            if (!canSpectatorPerformAction(state, registryEntry.role)) {
              socket.emit("game:error", {
                message:
                  "Spectators can only start fully-automated (AI-only) games.",
                source: "app",
              });
              return;
            }
          } else {
            const seat = state.players.find(
              (player) => player.id === intent.playerId
            );
            if (!seat) {
              socket.emit("game:error", {
                message: "Seat not found",
                source: "app",
              });
              return;
            }

            if (resolveSeatRuntime(seat) === "backend") {
              socket.emit("game:error", {
                message: "This seat is controlled by server AI",
                source: "app",
              });
              return;
            }

            const isHumanOwner =
              resolveSeatRuntime(seat) !== "frontend" &&
              registryEntry.playerId === seat.id;
            const isFrontendAiSponsor =
              resolveSeatRuntime(seat) === "frontend" &&
              seat.aiSponsorConnectionId === socket.id;

            if (!isHumanOwner && !isFrontendAiSponsor) {
              socket.emit("game:error", {
                message: "Not allowed to act for this seat",
                source: "app",
              });
              return;
            }

            if (
              !isFrontendAiSponsor &&
              registryEntry.playerId !== intent.playerId
            ) {
              socket.emit("game:error", {
                message: "Intent player mismatch",
                source: "app",
              });
              return;
            }
          }

          const events = getEvents(gameId);

          const applyEventOrNotify = (
            currentState: GameState,
            event: GameEvent,
            context: string
          ): GameState | null => {
            try {
              const next = applyEvent(currentState, event);
              appendEvent(intent.gameId, event);
              return next;
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              reportEngineWarning(
                intent.gameId,
                `${context}: ${errorMessage}`,
                error
              );
              return null;
            }
          };

          let intentForEngine: ClientIntent = effectiveIntent;
          if (effectiveIntent.type === "move") {
            const viewSalt = getViewSalt(gameId);
            const viewerKey = effectiveIntent.playerId;
            const viewToEngineCardId = (viewCardId: number): number | null =>
              resolveEngineCardId(viewCardId, viewSalt, viewerKey, state);

            if (effectiveIntent.cardIds && effectiveIntent.cardIds.length > 0) {
              const engineCardIds: number[] = [];
              for (const viewCardId of effectiveIntent.cardIds) {
                const engineCardId = viewToEngineCardId(viewCardId);
                if (engineCardId == null) {
                  const reason = "Unknown card";
                  socket.emit("game:validation", {
                    valid: false,
                    reason,
                    nextPlayer: null,
                    source: "engine",
                  });
                  socket.emit("game:invalid", { reason });
                  return;
                }
                engineCardIds.push(engineCardId);
              }

              intentForEngine = {
                type: "move",
                gameId: effectiveIntent.gameId,
                playerId: effectiveIntent.playerId,
                fromPileId: effectiveIntent.fromPileId,
                toPileId: effectiveIntent.toPileId,
                cardIds: engineCardIds,
                ...(typeof effectiveIntent.targetIndex === "number"
                  ? { targetIndex: effectiveIntent.targetIndex }
                  : {}),
              };
            } else if (effectiveIntent.cardId !== undefined) {
              const engineCardId = viewToEngineCardId(effectiveIntent.cardId);

              if (engineCardId == null) {
                const reason = "Unknown card";
                socket.emit("game:validation", {
                  valid: false,
                  reason,
                  nextPlayer: null,
                  source: "engine",
                });
                socket.emit("game:invalid", { reason });
                return;
              }

              intentForEngine = {
                type: "move",
                gameId: effectiveIntent.gameId,
                playerId: effectiveIntent.playerId,
                fromPileId: effectiveIntent.fromPileId,
                toPileId: effectiveIntent.toPileId,
                cardId: engineCardId,
                ...(typeof effectiveIntent.targetIndex === "number"
                  ? { targetIndex: effectiveIntent.targetIndex }
                  : {}),
              };
            }
          }

          const shortCircuit = preValidateIntentLocally(state, intentForEngine);
          if (shortCircuit.shortCircuit) {
            const reason =
              shortCircuit.reason ?? "Move rejected by local pre-validation.";

            socket.emit("game:validation", {
              valid: false,
              reason,
              nextPlayer: null,
              source: "engine",
            });
            socket.emit("game:invalid", {
              reason,
            });
            return;
          }

          let validation: ValidationResult;
          try {
            validation = await validateMove(state, events, intentForEngine);
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : "Failed to validate move";
            socket.emit("game:error", { message, source: "app" });
            console.error("Intent validation failed", error);
            return;
          }

          const acceptedValidation = validation.valid;
          const reason =
            validation.reason ?? (acceptedValidation ? null : "Invalid move");
          const validationSource = "engine" as const;

          // Suppress all success toasts; they are redundant with floating animations
          const shouldEmitValidation = !acceptedValidation;

          if (shouldEmitValidation) {
            socket.emit("game:validation", {
              valid: acceptedValidation,
              reason,
              nextPlayer: null,
              source: validationSource,
            });
          }
          if (!acceptedValidation) {
            socket.emit("game:invalid", {
              reason: reason ?? "Invalid move",
            });
            return;
          }

          const turnNumberForLog = getHumanTurnNumber(gameId);
          let workingState: GameState = state;
          const attributionContext = { directMoveAssigned: false };
          const appliedEngineEvents: EngineEvent[] = [];

          for (const ev of validation.engineEvents ?? []) {
            let dealerEvent: GameEvent;
            try {
              const attribution = resolveEventAttribution(
                intentForEngine,
                ev,
                attributionContext
              );
              dealerEvent = GameEventSchema.parse({
                id: Date.now(),
                gameId: intent.gameId,
                playerId: intentForEngine.playerId,
                ...attribution,
                ...ev,
              });
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Invalid dealer event";
              reportEngineWarning(
                intent.gameId,
                `Engine ignored invalid engine event: ${message}`,
                error
              );
              continue;
            }

            const validationResult = canApplyGameEvent(
              workingState,
              dealerEvent
            );
            if (!validationResult.ok) {
              reportEngineWarning(
                intent.gameId,
                `Engine ignored logic-invalid engine event: ${
                  validationResult.reason ?? "unknown"
                }`
              );
              continue;
            }

            const appliedState = applyEventOrNotify(
              workingState,
              dealerEvent,
              `Engine error applying ${ev.type}`
            );
            if (!appliedState) {
              return;
            }
            workingState = appliedState;
            appliedEngineEvents.push(ev);
          }

          let nextState: GameState | null;
          try {
            nextState = projectState(intent.gameId);
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            reportEngineWarning(
              intent.gameId,
              `Engine failed to project state: ${errorMessage}`,
              error
            );
            socket.emit("game:error", {
              message: `Engine failed to project state: ${errorMessage}`,
              source: "app",
            });
            return;
          }

          if (!nextState) {
            reportEngineWarning(
              intent.gameId,
              "Engine failed to project state: game not initialized"
            );
            socket.emit("game:error", {
              message: "Engine failed to project state: game not initialized",
              source: "app",
            });
            return;
          }

          broadcastState(
            io,
            playerRegistry,
            nextState,
            appliedEngineEvents.length > 0 ? appliedEngineEvents : undefined,
            {
              id: Math.random().toString(36).substring(2, 11),
              playerId: intent.playerId,
              action: intent.type === "action" ? intent.action : "move",
              label:
                intent.type === "action"
                  ? findActionLabel(state, intent.action)
                  : findMoveLabel(state, intentForEngine),
              ...(intentForEngine.type === "move"
                ? {
                    cardId: intentForEngine.cardId,
                    fromPileId: intentForEngine.fromPileId,
                    toPileId: intentForEngine.toPileId,
                  }
                : {}),
            }
          );

          appendGameLogIntent(state, intentForEngine, turnNumberForLog);
          appendExecutedIntentFromClientIntent(
            intent.gameId,
            intentForEngine,
            turnNumberForLog
          );

          // Check if we need to schedule an AI turn after successful move
          setTimeout(() => {
            import("./ai/ai-scheduler.js")
              .then(({ maybeScheduleAiTurn }) => {
                maybeScheduleAiTurn(gameId, broadcastStateToGame);
              })
              .catch((err) => {
                console.error("Failed to import ai-scheduler:", err);
                // Notify users that AI scheduling failed
                if (globalIoServer) {
                  globalIoServer.to(gameId).emit("game:error", {
                    message:
                      "AI system temporarily unavailable. Please try again.",
                    source: "app",
                  });
                }
              });
          }, 0);
        } catch (err) {
          console.error("[game:intent] structural error", err);

          socket.emit("game:status", {
            message:
              err instanceof Error
                ? err.message
                : "Move rejected due to structural error.",
            tone: "error" as const,
            source: "engine" as const,
          });

          socket.emit("game:invalid", {
            reason:
              err instanceof Error
                ? err.message
                : "Move rejected due to structural error.",
          });
        }
      });
    });

    socket.on(
      "game:prepare-ai-prompt",
      async ({
        gameId,
        playerId,
        expectedStateVersion,
      }: {
        gameId: string;
        playerId: string;
        expectedStateVersion?: number;
      }) => {
        try {
          const game = projectState(gameId);
          if (!game) {
            socket.emit("game:error", {
              message: "Game not found",
              source: "app",
            });
            return;
          }

          const currentStateVersion = getEvents(gameId).length;
          if (
            typeof expectedStateVersion === "number" &&
            expectedStateVersion !== currentStateVersion
          ) {
            socket.emit("game:ai-prompt-ready", {
              gameId,
              playerId,
              requestedStateVersion: expectedStateVersion,
              stateVersion: currentStateVersion,
              stale: true,
              error: "AI prompt request is stale.",
            });
            return;
          }

          const view = buildViewForPlayer(game, playerId);
          const { prepareAiPromptPayload } = await import("./ai/ai-policy.js");
          const payload = await prepareAiPromptPayload(
            gameId,
            game,
            view,
            playerId
          );

          socket.emit("game:ai-prompt-ready", {
            gameId,
            playerId,
            requestedStateVersion:
              typeof expectedStateVersion === "number"
                ? expectedStateVersion
                : currentStateVersion,
            stateVersion: currentStateVersion,
            ...payload,
          });
        } catch (err) {
          console.error("[game:prepare-ai-prompt] error", err);
          socket.emit("game:error", {
            message: "Failed to prepare AI prompt",
            source: "app",
          });
        }
      }
    );

    socket.on(
      "game:ai-log-llm-raw",
      ({
        gameId,
        playerId,
        content,
      }: {
        gameId: string;
        playerId: string;
        content: string;
      }) => {
        const turnNumber = getHumanTurnNumber(gameId);
        appendAiLogEntry({
          gameId,
          turnNumber,
          playerId,
          phase: "llm-raw",
          level: "info",
          message: "Received raw AI policy response from LLM (frontend).",
          source: "frontend",
          details: {
            kind: "llm-response-raw",
            content,
          },
        });
      }
    );

    socket.on(
      "game:ai-log-llm-parsed",
      ({
        gameId,
        playerId,
        parsed,
      }: {
        gameId: string;
        playerId: string;
        parsed: unknown;
      }) => {
        const turnNumber = getHumanTurnNumber(gameId);
        appendAiLogEntry({
          gameId,
          turnNumber,
          playerId,
          phase: "llm-parsed",
          level: "info",
          message: "Parsed AI policy response (frontend).",
          source: "frontend",
          details: {
            kind: "llm-response-parsed",
            parsed,
          },
        });
      }
    );

    socket.on(
      "game:ai-log-llm-error",
      ({
        gameId,
        playerId,
        errorDetails,
      }: {
        gameId: string;
        playerId: string;
        errorDetails: unknown;
      }) => {
        const turnNumber = getHumanTurnNumber(gameId);
        // Validate errorDetails with Zod instead of unsafe type assertion
        const validatedDetails = ErrorDetailsSchema.safeParse(errorDetails);
        appendAiLogEntry({
          gameId,
          turnNumber,
          playerId,
          phase: "error",
          level: "error",
          message: "LLM policy request failed (frontend).",
          source: "frontend",
          details: {
            kind: "llm-error",
            ...(validatedDetails.success ? validatedDetails.data : {}),
          },
        });
      }
    );

    interface SetSeatAiPayload {
      gameId: string;
      seatId: string;
      isAi: boolean;
    }

    socket.on("game:set-seat-ai", async (payload: SetSeatAiPayload) => {
      const { gameId, seatId, isAi } = payload ?? ({} as SetSeatAiPayload);

      if (
        typeof gameId !== "string" ||
        typeof seatId !== "string" ||
        typeof isAi !== "boolean"
      ) {
        socket.emit("game:error", {
          message: "Invalid AI toggle payload",
          source: "app",
        });
        return;
      }

      if (!hasGameAccess(socket.id, gameId)) {
        socket.emit("game:error", {
          message: "You are not joined to this game",
          source: "app",
        });
        return;
      }

      const requesterUserId = getSocketUserId(socket);
      await setHostUserIfMissing(gameId, requesterUserId);
      const enforceHostRestriction = await hasHostUserForGame(gameId);
      if (
        enforceHostRestriction &&
        !(await isHostUserForGame(gameId, requesterUserId))
      ) {
        socket.emit("game:error", {
          message: "Only the host can toggle seat AI",
          source: "app",
        });
        return;
      }

      // 1. Load game
      const state = projectState(gameId);
      if (!state) {
        socket.emit("game:error", {
          message: "Game not found",
          source: "app",
        });
        return;
      }

      if (isAi) {
        const plugin = GAME_PLUGINS[state.rulesId];
        const hasLegalIntents =
          plugin &&
          typeof plugin.ruleModule.listLegalIntentsForPlayer === "function";

        if (!hasLegalIntents) {
          console.warn(
            `[AI] Game rules id "${state.rulesId}" does not implement listLegalIntentsForPlayer, ` +
              `but seat ${seatId} is being set to AI. AI behaviour may be incorrect; ` +
              `this game is missing proper AI support in its rules module.`
          );
        }
      }

      // Optional: block only if game is finished, not just started
      if (state.winner) {
        socket.emit("game:error", {
          message: "Cannot set AI seat after game end",
          source: "app",
        });
        return;
      }

      // 3. Find the seat
      const seat = state.players.find((player) => player.id === seatId);
      if (!seat) {
        socket.emit("game:error", {
          message: "Seat not found",
          source: "app",
        });
        return;
      }

      // 4. Do not allow AI on an occupied seat with a human playerId (for now).
      const seatKeyStr = seatKey(gameId, seatId);
      if (seatAssignments.has(seatKeyStr) && isAi) {
        socket.emit("game:error", {
          message: "Cannot set AI while a human is occupying this seat",
          source: "app",
        });
        return;
      }

      // Update the seat's isAi flag in the game state
      const updateSuccessful = updatePlayerAiStatus(gameId, seatId, isAi);
      if (!updateSuccessful) {
        socket.emit("game:error", {
          message: "Failed to update AI status",
          source: "app",
        });
        return;
      }

      if (isAi) {
        if (isSupabaseIdentityEnabled()) {
          await ensureSeatClaimsLoadedForGame(gameId);
          const claim = getSeatClaimFromCache(gameId, seatId);
          const released = await releaseSeatOwnershipForAiSeat({
            gameId,
            seatId,
            ownerUserId: claim?.ownerUserId,
          });
          if (released) {
            removeSeatClaimFromCache(gameId, seatId);
          }
        }
        removeGuestSeatClaimFromCache(gameId, seatId);
      }

      // 6. Broadcast updated view to all clients in this game
      broadcastSeatStatus(gameId);
      broadcastStateToGame(gameId);

      // If the current player was just switched to backend AI mid-turn, trigger their move immediately.
      if (isAi) {
        const updatedState = projectState(gameId);
        const currentPlayerId = updatedState?.currentPlayer;
        const updatedSeat = updatedState?.players.find((p) => p.id === seatId);
        const aiRuntime =
          updatedSeat?.aiRuntime ?? (updatedSeat?.isAi ? "backend" : "none");

        if (currentPlayerId === seatId && aiRuntime === "backend") {
          maybeScheduleAiTurn(gameId, broadcastStateToGame);
        }
      }
    });

    interface SetSeatFrontendAiPayload {
      gameId: string;
      seatId: string;
      enabled: boolean;
    }

    socket.on(
      "game:setSeatFrontendAi",
      async (payload: SetSeatFrontendAiPayload | undefined) => {
        const { gameId, seatId, enabled } = payload ?? {};
        if (
          typeof gameId !== "string" ||
          typeof seatId !== "string" ||
          typeof enabled !== "boolean"
        ) {
          socket.emit("game:error", {
            message: "Invalid AI toggle payload",
            source: "app",
          });
          return;
        }

        if (!hasGameAccess(socket.id, gameId)) {
          socket.emit("game:error", {
            message: "You are not joined to this game",
            source: "app",
          });
          return;
        }

        const state = projectState(gameId);
        if (!state) {
          socket.emit("game:error", {
            message: "Game not found",
            source: "app",
          });
          return;
        }

        const seat = state.players.find((p) => p.id === seatId);
        if (!seat) {
          socket.emit("game:error", {
            message: "Seat not found",
            source: "app",
          });
          return;
        }

        const seatAssignmentKey = seatKey(gameId, seatId);
        const currentOccupant = seatAssignments.get(seatAssignmentKey);

        const seatTakenByOther =
          currentOccupant != null && currentOccupant !== socket.id;

        if (seatTakenByOther) {
          socket.emit("game:error", {
            message: "Cannot toggle AI for another seat",
            source: "app",
          });
          return;
        }

        // Frontend AI can be enabled from any seat role when the seat is free.

        const sponsorConnectionId = socket.id;
        const nextRuntime = enabled ? "frontend" : "none";
        setSeatRuntime(
          gameId,
          seatId,
          nextRuntime,
          enabled ? sponsorConnectionId : null
        );

        if (enabled) {
          if (isSupabaseIdentityEnabled()) {
            await ensureSeatClaimsLoadedForGame(gameId);
            const claim = getSeatClaimFromCache(gameId, seatId);
            const released = await releaseSeatOwnershipForAiSeat({
              gameId,
              seatId,
              ownerUserId: claim?.ownerUserId,
            });
            if (released) {
              removeSeatClaimFromCache(gameId, seatId);
            }
          }
          removeGuestSeatClaimFromCache(gameId, seatId);
        }

        broadcastStateToGame(gameId);
        broadcastSeatStatus(gameId);
      }
    );

    interface SetGodModePayload {
      gameId: string;
      isGodMode: boolean;
    }

    socket.on("game:set-god-mode", (payload: SetGodModePayload) => {
      const { gameId, isGodMode } = payload ?? {};

      if (typeof gameId !== "string" || typeof isGodMode !== "boolean") {
        socket.emit("game:error", {
          message: "Invalid god-mode payload",
          source: "app",
        });
        return;
      }

      const registryEntry = playerRegistry.get(socket.id);
      if (!registryEntry || registryEntry.gameId !== gameId) {
        socket.emit("game:error", {
          message: "You are not joined to this game",
          source: "app",
        });
        return;
      }

      if (registryEntry.role !== "spectator") {
        socket.emit("game:error", {
          message: "Only spectators can toggle god mode",
          source: "app",
        });
        return;
      }

      const updatedEntry: PlayerRegistryEntry = {
        ...registryEntry,
        isGodMode,
      };
      playerRegistry.set(socket.id, updatedEntry);

      const state = projectState(gameId);
      if (!state) {
        return;
      }

      const viewId = isGodMode ? "__god__" : "__spectator__";
      const view = buildViewForPlayer(state, viewId, socket.id);
      socket.emit("game:state", view);
    });

    socket.on("game:reset", async (gameId: string) => {
      try {
        const registryEntry = playerRegistry.get(socket.id);
        if (!registryEntry || registryEntry.gameId !== gameId) {
          socket.emit("game:error", {
            message: "You are not joined to this game",
            source: "app",
          });
          return;
        }

        const requesterUserId = getSocketUserId(socket);
        await setHostUserIfMissing(gameId, requesterUserId);
        const enforceHostRestriction = await hasHostUserForGame(gameId);
        if (
          enforceHostRestriction &&
          !(await isHostUserForGame(gameId, requesterUserId))
        ) {
          socket.emit("game:error", {
            message: "Only the host can reset the game",
            source: "app",
          });
          return;
        }

        if (registryEntry.role !== "player") {
          // Check if this is an AI-only game - allow spectators to restart AI-only games
          const state = projectState(gameId);
          if (!state) {
            socket.emit("game:error", {
              message: "Game not found",
              source: "app",
            });
            return;
          }

          // Use extracted utility function for spectator validation
          if (!canSpectatorPerformAction(state, registryEntry.role)) {
            socket.emit("game:error", {
              message:
                "Spectators can only reset fully-automated (AI-only) games.",
              source: "app",
            });
            return;
          }
          // Allow spectators to reset AI-only games
        }

        resetGame(gameId);

        // Keep seats occupied; just refresh seat status and game state for clients
        broadcastSeatStatus(gameId);
        io.to(gameId).emit("game:ended");

        const state = projectState(gameId);
        if (state) {
          broadcastState(io, playerRegistry, state);
        }
      } catch {
        socket.emit("game:error", {
          message: "Failed to reset game",
          source: "app",
        });
      }
    });

    socket.on(
      "game:reset-seed",
      async (payload: { gameId?: unknown; seed?: unknown }) => {
        try {
          const gameId = payload?.gameId;
          const seed = payload?.seed;
          if (typeof gameId !== "string" || typeof seed !== "string") {
            socket.emit("game:error", {
              message: "Invalid reset seed payload",
              source: "app",
            });
            return;
          }

          const registryEntry = playerRegistry.get(socket.id);
          if (!registryEntry || registryEntry.gameId !== gameId) {
            socket.emit("game:error", {
              message: "You are not joined to this game",
              source: "app",
            });
            return;
          }

          const requesterUserId = getSocketUserId(socket);
          await setHostUserIfMissing(gameId, requesterUserId);
          const enforceHostRestriction = await hasHostUserForGame(gameId);
          if (
            enforceHostRestriction &&
            !(await isHostUserForGame(gameId, requesterUserId))
          ) {
            socket.emit("game:error", {
              message: "Only the host can reset the game",
              source: "app",
            });
            return;
          }

          if (registryEntry.role !== "player") {
            // Check if this is an AI-only game - allow spectators to restart AI-only games
            const state = projectState(gameId);
            if (!state) {
              socket.emit("game:error", {
                message: "Game not found",
                source: "app",
              });
              return;
            }

            // Use extracted utility function for spectator validation
            if (!canSpectatorPerformAction(state, registryEntry.role)) {
              socket.emit("game:error", {
                message:
                  "Spectators can only reset fully-automated (AI-only) games.",
                source: "app",
              });
              return;
            }
            // Allow spectators to reset AI-only games
          }

          const ok = resetGameWithSeed(gameId, seed);
          if (!ok) {
            socket.emit("game:error", {
              message: "Game not found",
              source: "app",
            });
            return;
          }

          // Keep seats occupied; just refresh seat status and game state for clients
          broadcastSeatStatus(gameId);
          io.to(gameId).emit("game:ended");

          const state = projectState(gameId);
          if (state) {
            broadcastState(io, playerRegistry, state);
          }
        } catch {
          socket.emit("game:error", {
            message: "Failed to reset game with new seed",
            source: "app",
          });
        }
      }
    );

    socket.on(
      "game:append-ai-log",
      (payload: { gameId?: unknown; entry?: unknown }) => {
        const gameId = payload?.gameId;
        const entry = payload?.entry as
          | Omit<AiLogEntry, "timestamp">
          | undefined;
        if (typeof gameId !== "string" || !entry) {
          return;
        }

        const registryEntry = playerRegistry.get(socket.id);
        if (!registryEntry || registryEntry.gameId !== gameId) {
          return;
        }

        if (
          typeof entry.turnNumber !== "number" ||
          typeof entry.playerId !== "string" ||
          typeof entry.phase !== "string" ||
          typeof entry.level !== "string" ||
          typeof entry.message !== "string"
        ) {
          return;
        }

        // Extract timestamp safely without unsafe type assertions
        const timestamp =
          payload.entry &&
          typeof payload.entry === "object" &&
          "timestamp" in payload.entry &&
          typeof payload.entry.timestamp === "string"
            ? payload.entry.timestamp
            : undefined;

        appendAiLogEntry({
          ...entry,
          gameId,
          turnNumber: getHumanTurnNumber(gameId),
          timestamp,
        });
      }
    );

    socket.on(
      "game:get-ai-log",
      (
        payload: { gameId: string },
        cb?: (data: {
          gameId: string;
          entries: AiLogEntry[];
          historicalUnavailable?: boolean;
        }) => void
      ) => {
        const { gameId } = payload;
        const { entries, historicalUnavailable } = getAiLogSnapshot(gameId);
        const response = { gameId, entries, historicalUnavailable };

        if (cb) {
          cb(response);
        } else {
          socket.emit("game:ai-log", response);
        }
      }
    );

    socket.on(
      "game:get-log",
      (
        payload: { gameId?: unknown } | undefined,
        cb?: GameLogFetchCallback
      ) => {
        const respond = (response: GameLogFetchAck) => {
          if (cb) {
            cb(response);
            return;
          }
          socket.emit("game:log", response);
        };

        const gameId = payload?.gameId;
        if (typeof gameId !== "string" || gameId.trim() === "") {
          respond({ ok: false, message: "Invalid game log payload" });
          return;
        }

        if (!hasGameAccess(socket.id, gameId)) {
          respond({ ok: false, message: "You are not joined to this game" });
          return;
        }

        const viewerId = resolveGameLogViewerId(socket.id, gameId);
        const entries = buildGameLogEntries(gameId, viewerId);
        if (!entries) {
          respond({ ok: false, message: "Game not found" });
          return;
        }

        respond({
          ok: true,
          gameId,
          generatedAt: new Date().toISOString(),
          entries,
        });
      }
    );

    socket.on("game:retry-ai-turn", async ({ gameId }: { gameId: string }) => {
      try {
        const registryEntry = playerRegistry.get(socket.id);
        if (!registryEntry || registryEntry.gameId !== gameId) {
          socket.emit("game:error", {
            message: "You are not joined to this game",
            source: "app",
          });
          return;
        }

        const state = projectState(gameId);
        if (!state) {
          console.warn(
            `[AI Retry] Ignoring retry request: game ${gameId} not found`
          );
          return;
        }

        if (registryEntry.role !== "player") {
          // Use extracted utility function for spectator validation
          if (!canSpectatorPerformAction(state, registryEntry.role)) {
            socket.emit("game:error", {
              message:
                "Spectators can only trigger AI retries in fully-automated (AI-only) games.",
              source: "app",
            });
            return;
          }
        }

        const currentPlayerId = state.currentPlayer;
        if (!currentPlayerId) {
          console.warn(
            `[AI Retry] Ignoring retry request for game ${gameId}: no current player`
          );
          return;
        }

        const seat = state.players.find((p) => p.id === currentPlayerId);
        const aiRuntime = seat?.aiRuntime ?? (seat?.isAi ? "backend" : "none");
        if (!seat || aiRuntime !== "backend") {
          console.warn(
            `[AI Retry] Ignoring retry request for game ${gameId}: current player ${currentPlayerId} is not an AI seat`
          );
          return;
        }

        console.log("AI Retry: Manual retry requested", {
          gameId,
          currentPlayerId,
        });

        const requester = state.players.find(
          (player) => player.id === registryEntry.playerId
        );
        const requesterLabel = requester?.name
          ? `${requester.name} (${registryEntry.playerId})`
          : registryEntry.playerId;
        sendGameStatus(
          gameId,
          `AI retry requested by ${requesterLabel} for ${currentPlayerId}.`,
          "warning",
          "ai"
        );

        // Broadcast current state (without fatal errors) to clear the overlay for all players
        broadcastStateToGame(gameId);

        // Use the force function to handle in-flight tracking properly
        await forceRunAiTurnOnce(gameId, currentPlayerId, broadcastStateToGame);
      } catch (err) {
        console.error(
          `[AI Retry] Error while handling retry request for game:`,
          { gameId, error: err }
        );
      }
    });
  });
}
