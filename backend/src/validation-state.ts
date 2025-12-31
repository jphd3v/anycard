import type {
  ClientIntent,
  GameEvent,
  GameState,
  Pile,
} from "../../shared/schemas.js";
import type { ValidationHints } from "./rules/interface.js";
import { GAME_PLUGINS } from "./rules/registry.js";
import { isPileVisibleToPlayer } from "./visibility.js";

export interface SimplifiedEvent {
  index: number; // sequential index in the event log
  type: string; // e.g. "move-cards", "set-current-player"
  playerId: string | null;
  fromPileId?: string;
  toPileId?: string;
  cardIds?: number[];
}

export interface ValidationPileSummary {
  id: string;
  ownerId: string | null;
  size: number;
  topCard?: {
    id: number;
    rank: string;
    suit: string;
  };
  // For key piles like "battle", include full card list for rank comparison:
  cards?: Array<{
    id: number;
    rank: string;
    suit: string;
    // Optional: who played this card into battle.
    playedBy?: string | null;
  }>;
}

export interface ValidationState {
  gameId: string;
  rulesId: string;
  seed: string;
  currentPlayer: string | null;
  winner: string | null;
  piles: Record<string, ValidationPileSummary>;
  rulesState: unknown;
  moveIndex: number;
  recentEvents: SimplifiedEvent[];
  /** Full card registry for rule validation. */
  allCards: Record<number, { id: number; rank: string; suit: string }>;
}

function shouldIncludeFullCards(
  pile: Pile,
  intent: ClientIntent,
  hints: ValidationHints | undefined
): boolean {
  const sharedIds = new Set(hints?.sharedPileIds ?? []);
  const isAlwaysVisible =
    sharedIds.has(pile.id) ||
    hints?.isPileAlwaysVisibleToRules?.(pile.id) === true;

  // Rules must be able to enumerate the acting player's own hidden piles (e.g., hands).
  const isOwnedByActor =
    intent.playerId && pile.ownerId && pile.ownerId === intent.playerId;

  if (
    isAlwaysVisible ||
    isOwnedByActor ||
    pile.id.endsWith("-won") ||
    (intent.type === "move" &&
      (pile.id === intent.fromPileId || pile.id === intent.toPileId))
  ) {
    return true;
  }
  return pile.visibility === "public";
}

function shouldIncludeTopCard(
  pile: Pile,
  intent: ClientIntent,
  hints: ValidationHints | undefined
): boolean {
  if (shouldIncludeFullCards(pile, intent, hints)) {
    return true;
  }

  return isPileVisibleToPlayer(pile, intent.playerId ?? "__spectator__");
}

export function buildValidationState(
  gameState: GameState,
  events: GameEvent[],
  intent: ClientIntent
): ValidationState {
  const piles: Record<string, ValidationPileSummary> = {};
  const plugin = GAME_PLUGINS[gameState.rulesId];
  const hints = plugin?.validationHints;
  const playedByLookup =
    hints?.buildPlayedByLookup?.(gameState) ?? new Map<number, string | null>();
  const rulesState = gameState.rulesState;

  for (const [pileId, pile] of Object.entries(gameState.piles)) {
    const pileSummary: ValidationPileSummary = {
      id: pile.id,
      ownerId: pile.ownerId,
      size: pile.cardIds.length,
    };

    if (shouldIncludeTopCard(pile, intent, hints) && pile.cardIds.length > 0) {
      const topCardId = pile.cardIds[pile.cardIds.length - 1];
      const topCard = gameState.cards[topCardId];
      if (topCard) {
        pileSummary.topCard = {
          id: topCard.id,
          rank: topCard.rank,
          suit: topCard.suit,
        };
      }
    }

    if (shouldIncludeFullCards(pile, intent, hints)) {
      pileSummary.cards = pile.cardIds.map((cardId) => {
        const card = gameState.cards[cardId];
        if (card) {
          return {
            id: card.id,
            rank: card.rank,
            suit: card.suit,
            playedBy: playedByLookup.get(card.id) ?? null,
          };
        }
        return {
          id: cardId,
          rank: "unknown",
          suit: "unknown",
          playedBy: null,
        };
      });
    }

    piles[pileId] = pileSummary;
  }

  // Map GameEvent[] to SimplifiedEvent[]
  const allSimplifiedEvents: SimplifiedEvent[] = events.map((event, index) => {
    const simplified: SimplifiedEvent = {
      index,
      type: event.type,
      playerId: event.playerId,
    };

    if (event.type === "move-cards") {
      simplified.fromPileId = event.fromPileId;
      simplified.toPileId = event.toPileId;
      simplified.cardIds = event.cardIds;
    }

    return simplified;
  });

  // Take only the last 10 events
  const recentEvents = allSimplifiedEvents.slice(-10);

  const allCards: Record<number, { id: number; rank: string; suit: string }> =
    {};
  for (const [id, card] of Object.entries(gameState.cards)) {
    allCards[Number(id)] = {
      id: card.id,
      rank: card.rank,
      suit: card.suit,
    };
  }

  return {
    gameId: gameState.gameId,
    rulesId: gameState.rulesId,
    seed: gameState.seed ?? "",
    currentPlayer: gameState.currentPlayer,
    winner: gameState.winner,
    piles,
    rulesState: rulesState ?? null,
    moveIndex: events.length,
    recentEvents,
    allCards,
  };
}
