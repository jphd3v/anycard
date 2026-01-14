import { randomBytes } from "node:crypto";
import type {
  AiRuntimeLocation,
  GameEvent,
  GameState,
  MoveCardsEvent,
} from "../../shared/schemas.js";
import { clearAiLogForGame } from "./ai/ai-log.js";
import { isServerAiEnabled } from "./config.js";
import { applyShuffleToState } from "./shuffler.js";

/**
 * Invariant checks for GameState integrity.
 * These run only in development mode to catch structural corruption early.
 */
function assertInvariants(state: GameState): void {
  if (process.env.NODE_ENV === "production") {
    return;
  }

  // 1. Card conservation: all cards in state.cards must appear exactly once across all piles
  const allCardIds = Object.keys(state.cards).map(Number);
  const cardIdsInPiles = new Set<number>();

  for (const pile of Object.values(state.piles)) {
    for (const cardId of pile.cardIds) {
      cardIdsInPiles.add(cardId);
    }
  }

  // Check that every card is in exactly one pile
  const totalCardsInPiles = Object.values(state.piles).reduce(
    (sum, pile) => sum + pile.cardIds.length,
    0
  );

  if (totalCardsInPiles !== cardIdsInPiles.size) {
    throw new Error(
      `Invariant violation: Duplicate cards detected. ` +
        `Total cards in piles: ${totalCardsInPiles}, unique cards: ${cardIdsInPiles.size}`
    );
  }

  // Check that all cards from state.cards are accounted for in piles
  const missingCards = allCardIds.filter((id) => !cardIdsInPiles.has(id));
  if (missingCards.length > 0) {
    throw new Error(
      `Invariant violation: Cards missing from piles: ${missingCards.join(
        ", "
      )}`
    );
  }

  // Check for cards in piles that don't exist in state.cards
  const extraCards = Array.from(cardIdsInPiles).filter(
    (id) => !allCardIds.includes(id)
  );
  if (extraCards.length > 0) {
    throw new Error(
      `Invariant violation: Cards in piles not found in state.cards: ${extraCards.join(
        ", "
      )}`
    );
  }

  // 2. No duplicates: a card id doesn't appear in more than one pile
  const seenCards = new Map<number, string>();
  for (const [pileId, pile] of Object.entries(state.piles)) {
    for (const cardId of pile.cardIds) {
      const previousPile = seenCards.get(cardId);
      if (previousPile) {
        throw new Error(
          `Invariant violation: Card ${cardId} appears in both pile "${previousPile}" and pile "${pileId}"`
        );
      }
      seenCards.set(cardId, pileId);
    }
  }
}

const initialStateByGame = new Map<string, GameState>();
const eventsByGame = new Map<string, GameEvent[]>();
const finishedAtByGame = new Map<string, number>();
const viewSaltByGameId = new Map<string, string>();
const humanTurnByGame = new Map<
  string,
  { currentPlayerId: string | null; turnNumber: number }
>();

export function getViewSalt(gameId: string): string {
  const salt = viewSaltByGameId.get(gameId);
  if (!salt) {
    throw new Error(`Missing view salt for game ${gameId}`);
  }
  return salt;
}

const FINISHED_GAME_TTL_MS = Number(
  process.env.FINISHED_GAME_TTL_MS ?? 15 * 60 * 1000
);

const MAX_ACTIVE_GAMES = Number(process.env.MAX_ACTIVE_GAMES ?? 100);

function getActiveGameCount(): number {
  return initialStateByGame.size;
}

export function getAllGameIds(): string[] {
  return Array.from(initialStateByGame.keys());
}

export function initGame(state: GameState) {
  if (getActiveGameCount() >= MAX_ACTIVE_GAMES) {
    throw new Error(
      `Max active games (${MAX_ACTIVE_GAMES}) reached; refusing to create new game`
    );
  }

  viewSaltByGameId.set(state.gameId, randomBytes(16).toString("hex"));

  const snapshot: GameState = JSON.parse(JSON.stringify(state));
  initialStateByGame.set(state.gameId, snapshot);
  eventsByGame.set(state.gameId, []);
}

export function getEvents(gameId: string): GameEvent[] {
  return eventsByGame.get(gameId) ?? [];
}

export function appendEvent(gameId: string, event: GameEvent) {
  const events = eventsByGame.get(gameId) ?? [];
  events.push(event);
  eventsByGame.set(gameId, events);

  if (event.type === "set-winner") {
    finishedAtByGame.set(gameId, Date.now());
  }
}

export function resetGame(gameId: string) {
  if (!initialStateByGame.has(gameId)) {
    throw new Error(`Game ${gameId} not initialized`);
  }
  eventsByGame.set(gameId, []);
  clearAiLogForGame(gameId);
  humanTurnByGame.delete(gameId);
}

export function resetGameWithSeed(gameId: string, seed: string): boolean {
  const initial = initialStateByGame.get(gameId);
  if (!initial) {
    return false;
  }

  const snapshot: GameState = JSON.parse(JSON.stringify(initial));
  const reshuffled = applyShuffleToState(snapshot, seed);
  initialStateByGame.set(gameId, reshuffled);
  eventsByGame.set(gameId, []);
  finishedAtByGame.delete(gameId);
  clearAiLogForGame(gameId);
  humanTurnByGame.delete(gameId);
  return true;
}

export function closeGame(gameId: string): boolean {
  if (!initialStateByGame.has(gameId)) {
    return false;
  }

  initialStateByGame.delete(gameId);
  eventsByGame.delete(gameId);
  finishedAtByGame.delete(gameId);
  viewSaltByGameId.delete(gameId);
  humanTurnByGame.delete(gameId);
  clearAiLogForGame(gameId);
  return true;
}

export function trimFinishedGamesNow() {
  const now = Date.now();

  for (const [gameId, finishedAt] of finishedAtByGame.entries()) {
    if (now - finishedAt > FINISHED_GAME_TTL_MS) {
      initialStateByGame.delete(gameId);
      eventsByGame.delete(gameId);
      finishedAtByGame.delete(gameId);
      viewSaltByGameId.delete(gameId);
      humanTurnByGame.delete(gameId);
      clearAiLogForGame(gameId);
    }
  }
}

export function projectState(gameId: string): GameState | null {
  const initial = initialStateByGame.get(gameId);
  if (!initial) {
    return null;
  }

  return getEvents(gameId).reduce<GameState>(
    (state, event) => applyEvent(state, event),
    {
      ...initial,
      cards: { ...initial.cards },
      piles: { ...initial.piles },
      players: [...initial.players],
      currentPlayer: initial.currentPlayer,
      winner: initial.winner,
      rulesState: initial.rulesState,
      scoreboards: initial.scoreboards ? [...initial.scoreboards] : [],
    }
  );
}

export function getHumanTurnNumber(gameId: string): number {
  const state = projectState(gameId);
  if (!state) return 0;

  const currentPlayerId = state.currentPlayer ?? null;
  const previous = humanTurnByGame.get(gameId);

  if (!previous) {
    const initialTurn = currentPlayerId ? 1 : 0;
    humanTurnByGame.set(gameId, {
      currentPlayerId,
      turnNumber: initialTurn,
    });
    return initialTurn;
  }

  if (currentPlayerId && currentPlayerId !== previous.currentPlayerId) {
    const nextTurn = previous.turnNumber + 1;
    humanTurnByGame.set(gameId, {
      currentPlayerId,
      turnNumber: nextTurn,
    });
    return nextTurn;
  }

  if (currentPlayerId !== previous.currentPlayerId) {
    humanTurnByGame.set(gameId, {
      currentPlayerId,
      turnNumber: previous.turnNumber,
    });
  }

  return previous.turnNumber;
}

export function resetHumanTurnTracking(gameId: string): void {
  humanTurnByGame.delete(gameId);
}

export function updatePlayerAiStatus(
  gameId: string,
  playerId: string,
  isAi: boolean
): boolean {
  const serverEnabled = isServerAiEnabled();

  // Only use "backend" when BOTH:
  // - caller requested isAi === true
  // - server AI is actually enabled via env/config
  const runtime: AiRuntimeLocation = isAi && serverEnabled ? "backend" : "none";

  return setSeatRuntime(gameId, playerId, runtime, null);
}

export function setSeatRuntime(
  gameId: string,
  playerId: string,
  aiRuntime: AiRuntimeLocation,
  aiSponsorConnectionId: string | null
): boolean {
  const initialGameState = initialStateByGame.get(gameId);
  if (!initialGameState) {
    return false;
  }

  const player = initialGameState.players.find((p) => p.id === playerId);
  if (!player) {
    return false;
  }

  player.aiRuntime = aiRuntime;
  player.aiSponsorConnectionId = aiSponsorConnectionId;
  player.isAi = aiRuntime !== "none";
  return true;
}

export function applyEvent(state: GameState, event: GameEvent): GameState {
  let nextState: GameState;

  switch (event.type) {
    case "move-cards":
      nextState = applyMoveCards(state, event);
      break;
    case "set-pile-visibility": {
      const pile = state.piles[event.pileId];
      if (!pile) {
        nextState = state;
        break;
      }
      nextState = {
        ...state,
        piles: {
          ...state.piles,
          [event.pileId]: { ...pile, visibility: event.visibility },
        },
      };
      break;
    }
    case "set-card-visuals":
      nextState = {
        ...state,
        cardVisuals: event.visuals,
      };
      break;
    case "set-pile-properties":
      nextState = {
        ...state,
        pileProperties: event.properties,
      };
      break;
    case "set-current-player":
      nextState = {
        ...state,
        currentPlayer: event.player,
      };
      break;
    case "set-winner":
      nextState = {
        ...state,
        winner: event.winner,
      };
      clearAiLogForGame(state.gameId);
      humanTurnByGame.delete(state.gameId);
      break;
    case "set-rules-state":
      nextState = {
        ...state,
        rulesState: event.rulesState,
      };
      break;
    case "set-scoreboards":
      nextState = {
        ...state,
        scoreboards: event.scoreboards,
      };
      break;
    case "set-actions":
      nextState = {
        ...state,
        actions: event.actions,
      };
      break;
    default:
      nextState = state;
  }

  assertInvariants(nextState);
  return nextState;
}

function applyMoveCards(state: GameState, event: MoveCardsEvent): GameState {
  const { fromPileId, toPileId, cardIds, playerId } = event;
  const fromPile = state.piles[fromPileId];
  const toPile = state.piles[toPileId];

  if (!fromPile || !toPile) {
    return state;
  }

  // 3. Valid moves: reject move-cards where fromPile doesn't own those card ids
  if (process.env.NODE_ENV !== "production") {
    const missingCards = cardIds.filter(
      (cardId) => !fromPile.cardIds.includes(cardId)
    );
    if (missingCards.length > 0) {
      const message =
        `Invariant violation: Attempted to move cards [${missingCards.join(
          ", "
        )}] ` + `from pile "${fromPileId}" but they are not in that pile`;

      // Engine (playerId === null) events may become stale if the player's base move
      // already moved those cards. Treat them as no-ops instead of killing the server.
      if (playerId === null) {
        console.warn(message);
        if (missingCards.length === cardIds.length) {
          return state;
        }
      } else {
        throw new Error(message);
      }
    }
  }

  // Treat the requested card ids as a set: they define which cards to move,
  // while the source pile defines the canonical ordering.
  const requestedIds = new Set(cardIds);

  // Move cards in the exact order they appear in the source pile.
  const movingCardIds = fromPile.cardIds.filter((cardId) =>
    requestedIds.has(cardId)
  );

  // Nothing to move → no-op
  if (movingCardIds.length === 0) {
    return state;
  }

  // Remove moved cards from source, preserving order for remaining cards.
  const fromCardIds = fromPile.cardIds.filter(
    (cardId) => !requestedIds.has(cardId)
  );

  // Append moved cards to the end of the destination pile.
  // If moving within the same pile, we must append to the remaining cards (fromCardIds)
  // to avoid duplication, as toPile.cardIds still points to the original full list.
  const baseCardIds = fromPileId === toPileId ? fromCardIds : toPile.cardIds;
  const toCardIds = [...baseCardIds, ...movingCardIds];

  return {
    ...state,
    piles: {
      ...state.piles,
      [fromPileId]: { ...fromPile, cardIds: fromCardIds },
      [toPileId]: { ...toPile, cardIds: toCardIds },
    },
  };
}
