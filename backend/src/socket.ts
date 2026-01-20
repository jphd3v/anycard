import { Server, Socket } from "socket.io";
import type {
  ClientIntent,
  GameEvent,
  GameState,
  LastAction,
  SeatStatus,
} from "../../shared/schemas.js";
import { ClientIntentSchema, GameEventSchema } from "../../shared/schemas.js";
import type { ValidationResult, EngineEvent } from "../../shared/validation.js";
import { loadAndValidateGameConfig } from "./game-config.js";
import {
  appendEvent,
  applyEvent,
  getEvents,
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
} from "./state.js";
import { forceRunAiTurnOnce, maybeScheduleAiTurn } from "./ai/ai-scheduler.js";
import { getWarmupWarningMessage } from "./ai/ai-llm-policy.js";
import { buildViewForPlayer } from "./view.js";
import { listLegalIntentsForView, validateMove } from "./rule-engine.js";
import { generateGameId } from "./util/game-id.js";
import {
  appendAiLogEntry,
  getAiLog,
  initAiLogIo,
  sendGameStatus,
  type AiLogEntry,
} from "./ai/ai-log.js";
import { GAME_PLUGINS } from "./rules/registry.js";
import { resolveEngineCardId, toViewCardId } from "./view-ids.js";
import { getSuitSymbol } from "./util/card-notation.js";
import { isPileVisibleToPlayer } from "./visibility.js";

// Module-scoped state
type PlayerRole = "player" | "spectator";
type RoomType = "demo" | "public" | "private";
type PlayerRegistryEntry = {
  gameId: string;
  playerId: string;
  role: PlayerRole;
  isGodMode?: boolean;
};

export type ActiveGameSummary = {
  gameId: string;
  rulesId: string;
  numSeats: number;
  numOccupiedSeats: number;
  numSpectators: number;
  hasWinner: boolean;
  roomType: "demo" | "public";
  status: "waiting" | "playing" | "finished";
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
};

const playerRegistry = new Map<string, PlayerRegistryEntry>();
const watchRegistry = new Map<string, string>(); // socketId -> gameId
const seatAssignments = new Map<string, string>(); // key: `${gameId}:${playerId}` -> socketId
const gameProcessingChains = new Map<string, Promise<void>>();
const demoRoomsByRulesId = new Map<string, string>(); // rulesId -> gameId
const roomTypeByGameId = new Map<string, RoomType>();
const pendingCloseTimers = new Map<string, NodeJS.Timeout>();
const NO_HUMAN_CLOSE_DELAY_MS = 5 * 60 * 1000;
const DEMO_ABANDONED_RESET_DELAY_MS = 30 * 1000;
const DEFAULT_DEMO_SEED = "ESC0Q0";

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

  try {
    initGame(stateForGame);
  } catch (err) {
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
  gameProcessingChains.delete(gameId);
  closeGame(gameId);
  return true;
}

function shouldCloseGameForNoHumans(gameId: string): boolean {
  const state = projectState(gameId);
  if (!state) return false;

  const { playerCount, spectatorCount } = countConnectedHumans(gameId);
  return playerCount + spectatorCount === 0;
}

function maybeCloseAbandonedGame(io: Server, gameId: string): boolean {
  if (!shouldCloseGameForNoHumans(gameId)) {
    clearPendingClose(gameId);
    return false;
  }

  if (pendingCloseTimers.has(gameId)) {
    return false;
  }

  const isDemo = isDemoRoom(gameId);

  // All games wait for timeout - this allows human players to reconnect
  // even if they were playing against AI and minimized their browser
  const delay = isDemo
    ? DEMO_ABANDONED_RESET_DELAY_MS
    : NO_HUMAN_CLOSE_DELAY_MS;

  const timer = setTimeout(() => {
    pendingCloseTimers.delete(gameId);
    if (!shouldCloseGameForNoHumans(gameId)) {
      return;
    }

    if (isDemoRoom(gameId)) {
      const state = projectState(gameId);
      if (state) {
        const seed =
          typeof state.seed === "string" ? state.seed : DEFAULT_DEMO_SEED;
        resetGameWithSeed(gameId, seed);
        // After an abandoned reset, we notify the room (though it should be empty)
        broadcastSeatStatus(gameId);
        broadcastStateToGame(gameId);
      }
    } else {
      closeGameSession(io, gameId);
    }
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
    console.error(`Game ${gameId} not found for broadcast`);
    return;
  }

  broadcastState(
    globalIoServer,
    playerRegistry,
    state,
    lastEngineEvents,
    lastAction
  );
}

function enqueueGameWork(gameId: string, work: () => Promise<void>): void {
  const previous = gameProcessingChains.get(gameId) ?? Promise.resolve();

  const next = previous
    .catch(() => {
      // Swallow previous errors so they do not break the chain.
    })
    .then(work)
    .catch((err) => {
      console.error(`[game:intent] Error in game:`, { gameId, error: err });
    })
    .finally(() => {
      if (gameProcessingChains.get(gameId) === next) {
        gameProcessingChains.delete(gameId);
      }
    });

  gameProcessingChains.set(gameId, next);
}

function seatKey(gameId: string, playerId: string): string {
  return `${gameId}:${playerId}`;
}

function hasGameAccess(socketId: string, gameId: string): boolean {
  const registryEntry = playerRegistry.get(socketId);
  if (registryEntry) {
    return registryEntry.gameId === gameId;
  }
  return watchRegistry.get(socketId) === gameId;
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
      const occupied =
        seatAssignments.has(seatKey(gameId, player.id)) || aiRuntime !== "none";

      return {
        playerId: player.id,
        name: player.name,
        occupied,
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
    return {
      id: player.id,
      name: player.name,
      occupied: isHumanSeated || aiRuntime !== "none",
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
    if (roomType === "private") {
      continue;
    }

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
    });
  }

  return summaries;
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

    // No-op move guard: if moving from the same pile to the same pile
    if (intent.fromPileId === intent.toPileId) {
      return {
        shortCircuit: true,
        reason: "Moving a card within the same pile has no effect.",
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
        const view = buildViewForPlayer(state, viewId, socket.id);

        const viewerKey = viewId;

        const legalIntents =
          info.role === "player"
            ? listLegalIntentsForView(state.gameId, info.playerId).map(
                (intent) => {
                  if (intent.type !== "move") return intent;
                  if (intent.cardId !== undefined) {
                    return {
                      ...intent,
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
                      cardIds: intent.cardIds.map((id) =>
                        toViewCardId(id, viewSalt, info.playerId)
                      ),
                    };
                  }
                  return intent;
                }
              )
            : undefined;

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

        socket.emit("game:state", payload);
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

    socket.on("game:leave", () => {
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
      const watchedGameId = watchRegistry.get(socket.id);
      if (watchedGameId) {
        watchRegistry.delete(socket.id);
      }

      for (const gameId of getAllGameIds()) {
        const snapshot = projectState(gameId);
        if (!snapshot) continue;

        let changed = false;
        for (const player of snapshot.players) {
          const aiRuntime =
            player.aiRuntime ?? (player.isAi ? "backend" : "none");
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
      if (info) {
        if (info.role === "player") {
          const seatKeyValue = seatKey(info.gameId, info.playerId);
          if (seatAssignments.get(seatKeyValue) === socket.id) {
            seatAssignments.delete(seatKeyValue);
          }
        }
        playerRegistry.delete(socket.id);
      } else {
        playerRegistry.delete(socket.id);
      }

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
      (requestedGameType: string, seed?: string, options?: unknown) => {
        try {
          const opts =
            options && typeof options === "object"
              ? (options as {
                  dedicatedLobby?: boolean;
                  publicRoom?: boolean;
                  resetDedicated?: boolean;
                })
              : {};
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

          try {
            initGame(stateForGame);
          } catch (err) {
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
          if (isDemoRoomRequest) {
            demoRoomsByRulesId.set(requestedGameType, gameId);
            setRoomType(gameId, "demo");
          } else if (isPublicRoomRequest) {
            setRoomType(gameId, "public");
          } else {
            setRoomType(gameId, "private");
          }

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

    type WatchGamePayload = {
      gameId: string;
    };

    socket.on("game:watch", (raw: unknown) => {
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
      watchRegistry.set(socket.id, gameId);
      socket.join(gameId);
      sendSeatStatus(socket, gameId);
    });

    type JoinGamePayload = {
      gameId: string;
      playerId: string;
      role?: PlayerRole; // "player" | "spectator"
      isGodMode?: boolean;
    };

    socket.on("game:join", (raw: unknown) => {
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

      const state = projectState(gameId);
      if (!state) {
        socket.emit("game:error", {
          message: "Game not found",
          source: "app",
        });
        return;
      }

      clearPendingClose(gameId);

      // Ensure socket joins the correct room
      socket.join(gameId);
      stopWatching(socket, gameId);

      // Clear any previous seat assignment for this socket
      const existing = playerRegistry.get(socket.id);
      const oldGameId = existing?.gameId;
      if (existing) {
        const previousKey = seatKey(existing.gameId, existing.playerId);
        seatAssignments.delete(previousKey);
      }

      // Register this socket
      playerRegistry.set(socket.id, { gameId, playerId, role, isGodMode });

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

        // Player occupies their logical seat (one per playerId per game)
        const newSeatKey = seatKey(gameId, playerId);
        const currentOccupantId = seatAssignments.get(newSeatKey);

        if (currentOccupantId && currentOccupantId !== socket.id) {
          // If the seat is already taken, we allow the new socket to "reclaim" it.
          // This handles cases where a user refreshes their browser and their old
          // socket hasn't timed out yet.
          const oldSocket = io.sockets.sockets.get(currentOccupantId);
          if (oldSocket) {
            oldSocket.leave(gameId);
          }
          playerRegistry.delete(currentOccupantId);
        }

        seatAssignments.set(newSeatKey, socket.id);
      }

      // If we moved from a different game, notify that room of the vacancy
      if (oldGameId && oldGameId !== gameId) {
        broadcastSeatStatus(oldGameId);
      }

      // Spectators do NOT occupy any seat; they just join the room.

      const viewId =
        role === "player" ? playerId : isGodMode ? "__god__" : "__spectator__";
      const view = buildViewForPlayer(state, viewId, socket.id);

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

      socket.emit("game:state", {
        ...view,
        ...(legalIntents && legalIntents.length > 0 ? { legalIntents } : {}),
      });
      broadcastSeatStatus(gameId);
    });

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

          const resolveSeatRuntime = (seat: {
            aiRuntime?: "none" | "backend" | "frontend";
            isAi?: boolean;
          }): "none" | "backend" | "frontend" => {
            return seat.aiRuntime ?? (seat.isAi ? "backend" : "none");
          };

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
            if (isSpectator) {
              const allSeatsAutomated =
                state.players.length > 0 &&
                state.players.every(
                  (seat) => resolveSeatRuntime(seat) !== "none"
                );

              if (!allSeatsAutomated) {
                socket.emit("game:error", {
                  message:
                    "Spectators can only start fully-automated (AI-only) games.",
                  source: "app",
                });
                return;
              }
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
          const appliedEngineEvents: EngineEvent[] = [];

          for (const ev of validation.engineEvents ?? []) {
            let dealerEvent: GameEvent;
            try {
              dealerEvent = GameEventSchema.parse({
                id: Date.now(),
                gameId: intent.gameId,
                playerId: null,
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

          // Check if we need to schedule an AI turn after successful move
          setTimeout(() => {
            import("./ai/ai-scheduler.js").then(({ maybeScheduleAiTurn }) => {
              maybeScheduleAiTurn(gameId, broadcastStateToGame);
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
            ...(errorDetails as Record<string, unknown>),
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
      console.log("Received game:set-seat-ai event", { gameId, seatId, isAi });

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

      // 1. Load game
      const state = projectState(gameId);
      if (!state) {
        console.log("Game not found", { gameId });
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
        console.log("Cannot set AI seat: game is already finished", { gameId });
        return;
      }

      // 3. Find the seat
      const seat = state.players.find((player) => player.id === seatId);
      if (!seat) {
        console.log("Seat not found in game", { seatId, gameId });
        return;
      }

      // 4. Do not allow AI on an occupied seat with a human playerId (for now).
      const seatKeyStr = seatKey(gameId, seatId);
      if (seatAssignments.has(seatKeyStr) && isAi) {
        console.log(
          "Cannot set seat as AI: seat is already occupied by a human",
          { seatId }
        );
        // Optionally reject: seat already taken by human
        return;
      }

      console.log("Setting seat AI status", { seatId, isAi, gameId });

      // Update the seat's isAi flag in the game state
      const updateSuccessful = updatePlayerAiStatus(gameId, seatId, isAi);
      if (!updateSuccessful) {
        console.log("Failed to update AI status for seat", { seatId, gameId });
        return;
      }

      console.log("Successfully updated seat AI status", {
        seatId,
        isAi,
        gameId,
      });

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
      (payload: SetSeatFrontendAiPayload | undefined) => {
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

    socket.on("game:reset", (gameId: string) => {
      try {
        const registryEntry = playerRegistry.get(socket.id);
        if (!registryEntry || registryEntry.gameId !== gameId) {
          socket.emit("game:error", {
            message: "You are not joined to this game",
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

          const resolveSeatRuntime = (seat: {
            aiRuntime?: "none" | "backend" | "frontend";
            isAi?: boolean;
          }): "none" | "backend" | "frontend" => {
            return seat.aiRuntime ?? (seat.isAi ? "backend" : "none");
          };

          const allSeatsAutomated =
            state.players.length > 0 &&
            state.players.every((seat) => resolveSeatRuntime(seat) !== "none");

          if (!allSeatsAutomated) {
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

        io.to(gameId).emit("game:status", {
          message: "Game reset",
          tone: "neutral" as const,
          source: "app" as const,
        });
      } catch {
        socket.emit("game:error", {
          message: "Failed to reset game",
          source: "app",
        });
      }
    });

    socket.on(
      "game:reset-seed",
      (payload: { gameId?: unknown; seed?: unknown }) => {
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

            const resolveSeatRuntime = (seat: {
              aiRuntime?: "none" | "backend" | "frontend";
              isAi?: boolean;
            }): "none" | "backend" | "frontend" => {
              return seat.aiRuntime ?? (seat.isAi ? "backend" : "none");
            };

            const allSeatsAutomated =
              state.players.length > 0 &&
              state.players.every(
                (seat) => resolveSeatRuntime(seat) !== "none"
              );

            if (!allSeatsAutomated) {
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

          io.to(gameId).emit("game:status", {
            message: "Game reset with new seed",
            tone: "neutral" as const,
            source: "app" as const,
          });
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

        appendAiLogEntry({
          ...entry,
          gameId,
          turnNumber: getHumanTurnNumber(gameId),
          timestamp: (payload.entry as Record<string, unknown>)?.timestamp as
            | string
            | undefined,
        });
      }
    );

    socket.on(
      "game:get-ai-log",
      (
        payload: { gameId: string },
        cb?: (data: { gameId: string; entries: AiLogEntry[] }) => void
      ) => {
        const { gameId } = payload;
        const entries = getAiLog(gameId);
        const response = { gameId, entries };

        if (cb) {
          cb(response);
        } else {
          socket.emit("game:ai-log", response);
        }
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
          const resolveSeatRuntime = (seat: {
            aiRuntime?: "none" | "backend" | "frontend";
            isAi?: boolean;
          }): "none" | "backend" | "frontend" => {
            return seat.aiRuntime ?? (seat.isAi ? "backend" : "none");
          };

          const allSeatsAutomated =
            state.players.length > 0 &&
            state.players.every((seat) => resolveSeatRuntime(seat) !== "none");

          if (!allSeatsAutomated) {
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
