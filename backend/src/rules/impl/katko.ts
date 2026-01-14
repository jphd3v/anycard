import type { GameRuleModule, GamePlugin } from "../interface.js";
import type { ValidationState } from "../../validation-state.js";
import type { ClientIntent, Scoreboard } from "../../../../shared/schemas.js";
import type {
  ValidationResult,
  EngineEvent,
} from "../../../../shared/validation.js";
import type { AiView, AiContext } from "../../../../shared/src/ai/types.js";
import { loadGameMeta } from "../meta.js";
import { getSuitSymbol } from "../../util/card-notation.js";
import { gatherAllCards, shuffleAllCards } from "../util/dealing.js";

const META = loadGameMeta("katko");

interface KatkoRulesState {
  hasDealt: boolean;
  dealNumber: number; // NEW: tracks rounds for deterministic seed
  phase: "deal" | "play" | "game-over";
  scores: Record<string, number>;
  dealer: string;
  leadSuit: string | null;
  trickCount: number; // 0 to 5
  result: string | null;
  recap: string[]; // AI context: game history summaries
}

/**
 * Format a trick summary for the recap.
 * Example: "Trick 3: P1 K♠️, P2 7♠️ → P1 wins"
 */
function formatTrickSummary(
  trickNumber: number,
  leadCard: { rank: string; suit: string; playedBy: string },
  followCard: { rank: string; suit: string; playedBy: string },
  winner: string
): string {
  const leadLabel = `${leadCard.playedBy} ${leadCard.rank}${getSuitSymbol(leadCard.suit)}`;
  const followLabel = `${followCard.playedBy} ${followCard.rank}${getSuitSymbol(followCard.suit)}`;
  return `Trick ${trickNumber}: ${leadLabel}, ${followLabel} → ${winner} wins`;
}

/**
 * Create a hand summary that collapses trick-by-trick details.
 * Example: "Hand 2: P1 won last trick, scores P1=1 P2=1"
 */
function formatHandSummary(
  handNumber: number,
  winner: string,
  scores: Record<string, number>
): string {
  return `Hand ${handNumber}: ${winner} won last trick. Scores: P1=${scores["P1"] || 0}, P2=${scores["P2"] || 0}`;
}

function getRulesState(obj: unknown): KatkoRulesState {
  const base: KatkoRulesState = {
    hasDealt: false,
    dealNumber: 0,
    phase: "deal",
    scores: { P1: 0, P2: 0 },
    dealer: "P1",
    leadSuit: null,
    trickCount: 0,
    result: null,
    recap: [],
  };
  if (!obj || typeof obj !== "object") return base;
  const o = obj as Record<string, unknown>;
  return {
    hasDealt: typeof o.hasDealt === "boolean" ? o.hasDealt : base.hasDealt,
    dealNumber:
      typeof o.dealNumber === "number" ? o.dealNumber : base.dealNumber,
    phase: ["deal", "play", "game-over"].includes(o.phase as string)
      ? (o.phase as KatkoRulesState["phase"])
      : base.phase,
    scores:
      o.scores && typeof o.scores === "object"
        ? (o.scores as Record<string, number>)
        : base.scores,
    dealer: typeof o.dealer === "string" ? o.dealer : base.dealer,
    leadSuit: typeof o.leadSuit === "string" ? o.leadSuit : base.leadSuit,
    trickCount:
      typeof o.trickCount === "number" ? o.trickCount : base.trickCount,
    result: typeof o.result === "string" ? o.result : base.result,
    recap: Array.isArray(o.recap) ? o.recap : base.recap,
  };
}

const RANK_MAP: Record<string, number> = {
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

function getRankValue(rankStr: string): number {
  return RANK_MAP[rankStr] || 0;
}

function getOtherPlayer(current: string): string {
  return current === "P1" ? "P2" : "P1";
}

function buildScoreboard(rulesState: KatkoRulesState): Scoreboard[] {
  return [
    {
      id: "katko-score",
      title: "Score",
      rows: 2,
      cols: 2,
      cells: [
        { row: 0, col: 0, text: "Player 1", role: "header" },
        {
          row: 0,
          col: 1,
          text: String(rulesState.scores["P1"] || 0),
          role: "body",
        },
        { row: 1, col: 0, text: "Player 2", role: "header" },
        {
          row: 1,
          col: 1,
          text: String(rulesState.scores["P2"] || 0),
          role: "body",
        },
      ],
    },
  ];
}

export const katkoRules: GameRuleModule = {
  validate(state: ValidationState, intent: ClientIntent): ValidationResult {
    const engineEvents: EngineEvent[] = [];
    const rulesState = getRulesState(state.rulesState);

    // 0. Handle Start Game / New Round Deal
    if (!rulesState.hasDealt) {
      if (intent.type === "action" && intent.action === "start-game") {
        const deckPile = state.piles["deck"];
        if (!deckPile || !deckPile.cards) {
          return {
            valid: false,
            reason: "System Error: Deck not found",
            engineEvents: [],
          };
        }

        const nextDealNumber = (rulesState.dealNumber || 0) + 1;
        const currentDeckCards = deckPile.cards;
        let cardsToDeal: number[] = [];

        if (nextDealNumber === 1 || currentDeckCards.length < 10) {
          // Time to shuffle (first deal or deck empty)
          engineEvents.push(...gatherAllCards(state));

          // Use a specific shuffle seed based on how many times we've shuffled
          const shuffleCount = Math.floor((nextDealNumber - 1) / 5); // Approx 5 deals per deck
          const shuffledCardIds = shuffleAllCards(state, shuffleCount, "KATKO");
          cardsToDeal = shuffledCardIds;
        } else {
          // Deal from remaining cards
          cardsToDeal = currentDeckCards.map((c) => c.id);
        }

        if (cardsToDeal.length < 10) {
          return { valid: false, reason: "Deck exhausted.", engineEvents: [] };
        }

        const p1Cards = cardsToDeal.slice(0, 5);
        const p2Cards = cardsToDeal.slice(5, 10);

        engineEvents.push(
          {
            type: "move-cards",
            fromPileId: "deck",
            toPileId: "P1-hand",
            cardIds: p1Cards as [number, ...number[]],
          },
          {
            type: "move-cards",
            fromPileId: "deck",
            toPileId: "P2-hand",
            cardIds: p2Cards as [number, ...number[]],
          }
        );

        const starter = getOtherPlayer(rulesState.dealer);

        // Add hand start message to recap
        const nextRecap = [
          ...rulesState.recap,
          `Hand ${nextDealNumber} started (dealer ${rulesState.dealer}).`,
        ];

        engineEvents.push({
          type: "set-rules-state",
          rulesState: {
            ...rulesState,
            hasDealt: true,
            dealNumber: nextDealNumber,
            phase: "play",
            leadSuit: null,
            trickCount: 0,
            result: null,
            recap: nextRecap,
          },
        });

        engineEvents.push({ type: "set-current-player", player: starter });

        return { valid: true, engineEvents };
      } else {
        return {
          valid: false,
          reason: "Waiting for the game to be dealt. Click 'Start Game'.",
          engineEvents: [],
        };
      }
    }

    if (state.winner)
      return {
        valid: false,
        reason: "The game is already over.",
        engineEvents: [],
      };

    // 1. Move Validation
    if (intent.type !== "move")
      return {
        valid: false,
        reason: "Katko only supports playing cards as move intents.",
        engineEvents: [],
      };

    if (state.currentPlayer !== intent.playerId)
      return { valid: false, reason: "It is not your turn.", engineEvents: [] };

    const handId = `${intent.playerId}-hand`;
    if (intent.fromPileId !== handId)
      return {
        valid: false,
        reason: "You must play cards from your own hand.",
        engineEvents: [],
      };
    if (intent.toPileId !== "trick")
      return {
        valid: false,
        reason: "You must play cards to the trick pile.",
        engineEvents: [],
      };

    const hand = state.piles[handId];
    // Engine guarantees card exists in source pile
    const playedCard = hand.cards!.find((c) => c.id === intent.cardId)!;

    // Check Suit
    const trick = state.piles["trick"];
    const trickCards = trick?.cards || [];

    if (trickCards.length > 0) {
      // Following
      const leadCard = trickCards[0];
      const leadSuit = leadCard.suit;

      if (playedCard.suit !== leadSuit) {
        // Check if player has lead suit
        const hasSuitInHand = hand.cards?.some((c) => c.suit === leadSuit);
        if (hasSuitInHand) {
          return {
            valid: false,
            reason: `Must follow suit (${getSuitSymbol(leadSuit)})`,
            engineEvents: [],
          };
        }
      }
    }

    // Valid move
    engineEvents.push({
      type: "move-cards",
      fromPileId: handId,
      toPileId: "trick",
      cardIds: [playedCard.id],
    });

    // Logic after move
    const cardsInTrick = trickCards.length + 1; // +1 for the card just played

    let nextPlayer = getOtherPlayer(intent.playerId);
    const nextRulesState = { ...rulesState };

    if (cardsInTrick === 1) {
      // First card played
      nextRulesState.leadSuit = playedCard.suit;
      engineEvents.push({ type: "set-current-player", player: nextPlayer });
    } else {
      // Trick complete (2 cards)
      const c1 = trickCards[0]; // Lead
      const c2 = playedCard; // Follow

      // Determine who played the lead card
      const leadPlayer = getOtherPlayer(intent.playerId);

      let winnerId = "";

      if (c2.suit === c1.suit) {
        if (getRankValue(c2.rank) > getRankValue(c1.rank)) {
          winnerId = intent.playerId; // P2 (responder) wins
        } else {
          winnerId = leadPlayer; // P1 (leader) wins
        }
      } else {
        // Followed with different suit -> Lead wins
        winnerId = leadPlayer;
      }

      // Winner leads next
      nextPlayer = winnerId;
      engineEvents.push({ type: "set-current-player", player: winnerId });

      // Move trick to discard
      engineEvents.push({
        type: "move-cards",
        fromPileId: "trick",
        toPileId: "discard",
        cardIds: [c1.id, c2.id],
      });

      nextRulesState.trickCount++;
      nextRulesState.leadSuit = null;

      // Add trick summary to recap
      const trickSummary = formatTrickSummary(
        nextRulesState.trickCount,
        { rank: c1.rank, suit: c1.suit, playedBy: leadPlayer },
        { rank: c2.rank, suit: c2.suit, playedBy: intent.playerId },
        winnerId
      );

      // Check if round over (5 tricks)
      if (nextRulesState.trickCount >= 5) {
        // Point to winner of LAST trick
        const currentScores = { ...nextRulesState.scores };
        currentScores[winnerId] = (currentScores[winnerId] || 0) + 1;
        nextRulesState.scores = currentScores;
        nextRulesState.result = `Hand ${rulesState.dealNumber} Result: ${winnerId} won the point. Scores: P1=${currentScores["P1"] || 0}, P2=${currentScores["P2"] || 0}.`;

        // Collapse recap to hand summary (replace trick-by-trick with summary)
        nextRulesState.recap = [
          formatHandSummary(rulesState.dealNumber, winnerId, currentScores),
        ];

        // Check game win (first to 3)
        if (currentScores[winnerId] >= 3) {
          nextRulesState.phase = "game-over";
          engineEvents.push({ type: "set-winner", winner: winnerId });
        } else {
          // Prepare next round
          nextRulesState.hasDealt = false;
          nextRulesState.phase = "deal";
          nextRulesState.dealer = winnerId; // Winner of last trick becomes the next dealer
          nextRulesState.trickCount = 0;
        }
      } else {
        // Add trick summary to recap (not end of hand)
        nextRulesState.recap = [...rulesState.recap, trickSummary];
      }
    }

    engineEvents.push({ type: "set-rules-state", rulesState: nextRulesState });
    engineEvents.push({
      type: "set-scoreboards",
      scoreboards: buildScoreboard(nextRulesState),
    });

    return { valid: true, engineEvents };
  },

  listLegalIntentsForPlayer(
    state: ValidationState,
    playerId: string
  ): ClientIntent[] {
    const intents: ClientIntent[] = [];
    const rulesState = getRulesState(state.rulesState);
    const gameId = state.gameId;

    if (!rulesState?.hasDealt) {
      const candidate: ClientIntent = {
        type: "action",
        gameId,
        playerId,
        action: "start-game",
      };
      if (this.validate(state, candidate).valid) {
        intents.push(candidate);
      }
      return intents;
    }

    if (state.winner || state.currentPlayer !== playerId) return [];

    const handId = `${playerId}-hand`;
    const hand = state.piles[handId];
    if (!hand || !hand.cards) return [];

    const candidates: ClientIntent[] = [];
    for (const card of hand.cards) {
      candidates.push({
        type: "move",
        gameId,
        playerId,
        fromPileId: handId,
        toPileId: "trick",
        cardId: card.id,
      });
    }

    for (const c of candidates) {
      if (this.validate(state, c).valid) {
        intents.push(c);
      }
    }

    return intents;
  },
};

export const katkoPlugin: GamePlugin = {
  id: "katko",
  gameName: META.gameName,
  ruleModule: katkoRules,
  description: META.description,
  validationHints: {
    sharedPileIds: ["deck", "trick", "discard", "P1-hand", "P2-hand"],
  },
  aiSupport: {
    buildContext: (view: AiView): AiContext => {
      const rulesState = getRulesState(
        (view.public as { rulesState?: unknown }).rulesState
      );

      // Build facts from game state
      const facts: Record<string, unknown> = {
        phase: rulesState.phase,
        dealNumber: rulesState.dealNumber,
        trickCount: rulesState.trickCount,
        scores: rulesState.scores,
      };

      if (rulesState.leadSuit) {
        facts.leadSuit = rulesState.leadSuit;
      }

      return {
        recap: rulesState.recap.length > 0 ? rulesState.recap : undefined,
        facts,
      };
    },
  },
};
