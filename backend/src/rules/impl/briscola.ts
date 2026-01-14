/**
 * Canonical Briscola rules (deterministic TypeScript implementation).
 *
 * 2-player Italian trick-taking game with:
 * - 40-card deck (A,2,3,4,5,6,7,J,Q,K in each suit)
 * - Briscola (trump) suit determined by flipped card
 * - Point scoring: A=11, 3=10, K=4, Q=3, J=2
 * - Highest card in lead suit wins, or highest briscola
 */

import type {
  GameRuleModule,
  GamePlugin,
  ValidationHints,
} from "../interface.js";
import type { ValidationState } from "../../validation-state.js";
import type { ClientIntent, Scoreboard } from "../../../../shared/schemas.js";
import type {
  EngineEvent,
  ValidationResult,
} from "../../../../shared/validation.js";
import { loadGameMeta } from "../meta.js";
import { getSuitSymbol } from "../../util/card-notation.js";
import { appendHistoryDigest, type AgentGuide } from "../util/agent-guide.js";
import { projectPilesAfterEvents, type ProjectedPiles } from "../util/piles.js";
import {
  gatherAllCards,
  shuffleAllCards,
  distributeRoundRobin,
} from "../util/dealing.js";

const META = loadGameMeta("briscola");

type BriscolaPhase = "deal" | "playing" | "ended";

interface BriscolaRulesState {
  hasDealt: boolean;
  dealNumber: number; // NEW: tracks full deck deals
  phase: BriscolaPhase;
  roundNumber: number;
  players: string[];
  briscolaSuit: string | null;
  result: string | null;
  currentTrick: Array<{ cardId: number; playedBy: string }> | null;
  agentGuide?: AgentGuide;
}

type SimpleCard = { id: number; rank: string; suit: string };

// --- Helpers ---

const CARD_POINTS: Record<string, number> = {
  A: 11,
  "3": 10,
  K: 4,
  Q: 3,
  J: 2,
  "2": 0,
  "4": 0,
  "5": 0,
  "6": 0,
  "7": 0,
};

const CARD_RANK_VALUES: Record<string, number> = {
  A: 11,
  "3": 10,
  K: 9,
  Q: 8,
  J: 7,
  "7": 6,
  "6": 5,
  "5": 4,
  "4": 3,
  "2": 2,
};

function getBriscolaRulesState(
  raw: unknown,
  players: string[]
): BriscolaRulesState {
  const base: BriscolaRulesState = {
    hasDealt: false,
    dealNumber: 0,
    phase: "deal",
    roundNumber: 1,
    players,
    briscolaSuit: null,
    result: null,
    currentTrick: null,
    agentGuide: { historyDigest: [] },
  };

  if (!raw || typeof raw !== "object") return base;

  const obj = raw as Partial<BriscolaRulesState>;

  return {
    hasDealt: obj.hasDealt ?? base.hasDealt,
    dealNumber: obj.dealNumber ?? base.dealNumber,
    phase: obj.phase ?? base.phase,
    roundNumber: obj.roundNumber ?? base.roundNumber,
    players:
      Array.isArray(obj.players) && obj.players.length > 0
        ? obj.players
        : base.players,
    briscolaSuit: obj.briscolaSuit ?? base.briscolaSuit,
    result: obj.result ?? base.result,
    currentTrick: obj.currentTrick ?? base.currentTrick,
    agentGuide: obj.agentGuide ?? base.agentGuide,
  };
}

function getOtherPlayer(current: string, players: string[]): string {
  const other = players.find((p) => p !== current);
  return other ?? current;
}

function cardPoints(rank: string): number {
  return CARD_POINTS[rank] ?? 0;
}

function cardRankValue(rank: string): number {
  return CARD_RANK_VALUES[rank] ?? 0;
}

function formatCardLabel(card: { rank: string; suit: string }): string {
  return `${card.rank} of ${card.suit}`;
}

function formatTrickSummary(
  trickCards: Array<{ rank: string; suit: string; playedBy?: string | null }>,
  winner: string
): string {
  const plays = trickCards
    .map((card) =>
      card.playedBy
        ? `${card.playedBy} ${formatCardLabel(card)}`
        : formatCardLabel(card)
    )
    .join(", ");
  return `Trick: ${plays}; winner ${winner}.`;
}

// Determine trick winner
function determineTrickWinner(
  trickCards: Array<SimpleCard & { playedBy?: string | null }>,
  briscolaSuit: string | null
): string {
  if (trickCards.length === 0) return "";

  const leadSuit = trickCards[0].suit;
  const briscolaCards = trickCards.filter((c) => c.suit === briscolaSuit);

  // If any briscola was played, highest briscola wins
  if (briscolaCards.length > 0) {
    const winnerCard = briscolaCards.reduce((winner, card) =>
      cardRankValue(card.rank) > cardRankValue(winner.rank) ? card : winner
    );
    return winnerCard.playedBy ?? "";
  }

  // Otherwise, highest card in lead suit wins
  const leadSuitCards = trickCards.filter((c) => c.suit === leadSuit);
  const winnerCard = leadSuitCards.reduce((winner, card) =>
    cardRankValue(card.rank) > cardRankValue(winner.rank) ? card : winner
  );
  return winnerCard.playedBy ?? "";
}

// Compute scores
function computeScores(
  projected: ProjectedPiles,
  rulesState: BriscolaRulesState
): Record<string, { points: number; cards: number }> {
  const result: Record<string, { points: number; cards: number }> = {};
  const players = rulesState.players;

  for (const pid of players) {
    const won = projected[`${pid}-won`];
    const cards = won?.cards ?? [];

    let totalPoints = 0;
    for (const card of cards) {
      totalPoints += cardPoints(card.rank);
    }

    result[pid] = {
      points: totalPoints,
      cards: cards.length,
    };
  }

  return result;
}

function buildScoreboard(
  projected: ProjectedPiles,
  rulesState: BriscolaRulesState
): Scoreboard {
  const players = rulesState.players;
  const scores = computeScores(projected, rulesState);

  const rows = players.length + 2;
  const cols = 3;
  const cells: Scoreboard["cells"] = [];

  // Headers
  cells.push({ row: 0, col: 0, text: "Player", role: "header", align: "left" });
  cells.push({
    row: 0,
    col: 1,
    text: "Points",
    role: "header",
    align: "right",
  });
  cells.push({ row: 0, col: 2, text: "Cards", role: "header", align: "right" });

  // Player rows
  players.forEach((pid, index) => {
    const s = scores[pid];
    cells.push({
      row: index + 1,
      col: 0,
      text: pid,
      role: "header",
      align: "left",
    });
    cells.push({
      row: index + 1,
      col: 1,
      text: String(s.points),
      align: "right",
    });
    cells.push({
      row: index + 1,
      col: 2,
      text: String(s.cards),
      align: "right",
    });
  });

  // Briscola row
  const briscolaText = rulesState.briscolaSuit
    ? getSuitSymbol(rulesState.briscolaSuit)
    : "None";
  cells.push({
    row: rows - 1,
    col: 0,
    text: "Trump Suit",
    role: "header",
    align: "left",
  });
  cells.push({
    row: rows - 1,
    col: 1,
    text: briscolaText,
    colspan: 2,
    align: "center",
  });

  return {
    id: "briscola-main",
    title: "Briscola score",
    rows,
    cols,
    cells,
  };
}

function determineWinner(
  projected: ProjectedPiles,
  rulesState: BriscolaRulesState
): string | null {
  const scores = computeScores(projected, rulesState);
  const players = rulesState.players;

  if (players.length !== 2) return null;

  const [p1, p2] = players;
  const s1 = scores[p1].points;
  const s2 = scores[p2].points;

  if (s1 > s2) return p1;
  if (s2 > s1) return p2;
  return null; // Tie
}

// Redo drawCardsToRefill for clarity and correctness
function refillHands(
  projectedAfterTrick: ProjectedPiles,
  rulesState: BriscolaRulesState,
  winnerId: string
): EngineEvent[] {
  const events: EngineEvent[] = [];
  const players = rulesState.players;
  const loserId = getOtherPlayer(winnerId, players);

  const deck = projectedAfterTrick["deck"];
  const briscolaPile = projectedAfterTrick["briscola"];

  if (!deck || !briscolaPile) return events;

  // Draw for winner
  if (deck.cardIds && deck.cardIds.length > 0) {
    const cardId = deck.cardIds[deck.cardIds.length - 1];
    events.push({
      type: "move-cards",
      fromPileId: "deck",
      toPileId: `${winnerId}-hand`,
      cardIds: [cardId],
    });
    deck.cardIds.pop();
    deck.size--;
  } else if (briscolaPile.cardIds && briscolaPile.cardIds.length > 0) {
    const cardId = briscolaPile.cardIds[0];
    events.push({
      type: "move-cards",
      fromPileId: "briscola",
      toPileId: `${winnerId}-hand`,
      cardIds: [cardId],
    });
    briscolaPile.cardIds.shift();
    briscolaPile.size--;
  }

  // Draw for loser
  if (deck.cardIds && deck.cardIds.length > 0) {
    const cardId = deck.cardIds[deck.cardIds.length - 1];
    events.push({
      type: "move-cards",
      fromPileId: "deck",
      toPileId: `${loserId}-hand`,
      cardIds: [cardId],
    });
    deck.cardIds.pop();
    deck.size--;
  } else if (briscolaPile.cardIds && briscolaPile.cardIds.length > 0) {
    const cardId = briscolaPile.cardIds[0];
    events.push({
      type: "move-cards",
      fromPileId: "briscola",
      toPileId: `${loserId}-hand`,
      cardIds: [cardId],
    });
    briscolaPile.cardIds.shift();
    briscolaPile.size--;
  }

  return events;
}

function computeCardVisuals(
  state: ValidationState,
  nextRulesState: BriscolaRulesState,
  engineEvents: EngineEvent[]
): EngineEvent {
  const projected = projectPilesAfterEvents(state, engineEvents);
  const briscolaPile = projected["briscola"];
  const visuals: Record<number, { rotationDeg?: number }> = {};
  if (briscolaPile && (briscolaPile.cardIds?.length ?? 0) > 0) {
    visuals[briscolaPile.cardIds![0]] = { rotationDeg: 90 };
  }
  return { type: "set-card-visuals", visuals };
}

export const briscolaRules: GameRuleModule = {
  listLegalIntentsForPlayer(
    state: ValidationState,
    playerId: string
  ): ClientIntent[] {
    const intents: ClientIntent[] = [];
    const players = state.piles
      ? Object.keys(state.piles)
          .filter((id) => id.endsWith("-hand"))
          .map((id) => id.replace("-hand", ""))
      : ["P1", "P2"];

    const rulesState = getBriscolaRulesState(state.rulesState, players);
    const gameId = state.gameId;

    // If not dealt yet, allow start action
    if (!rulesState.hasDealt) {
      intents.push({
        type: "action",
        gameId,
        playerId,
        action: "start-game",
      });
      return intents;
    }

    // If game is ended, no legal moves
    if (rulesState.phase === "ended") {
      return intents;
    }

    // Check it's current player's turn
    if (!state.currentPlayer || state.currentPlayer !== playerId) {
      return intents;
    }

    const playerHandPileId = `${playerId}-hand`;
    const playerHand = state.piles[playerHandPileId];

    if (!playerHand || !playerHand.cards) {
      return intents;
    }

    // For each card in player's hand, generate possible moves to trick pile
    for (const card of playerHand.cards) {
      const candidate: ClientIntent = {
        type: "move",
        gameId,
        playerId,
        fromPileId: playerHandPileId,
        toPileId: "trick",
        cardId: card.id,
      };
      if (this.validate(state, candidate).valid) {
        intents.push(candidate);
      }
    }

    return intents;
  },

  validate(state: ValidationState, intent: ClientIntent): ValidationResult {
    const players = state.piles
      ? Object.keys(state.piles)
          .filter((id) => id.endsWith("-hand"))
          .map((id) => id.replace("-hand", ""))
      : ["P1", "P2"];

    const rulesState = getBriscolaRulesState(state.rulesState, players);
    const engineEvents: EngineEvent[] = [];
    let nextRulesState: BriscolaRulesState = { ...rulesState };

    // Before dealing has been performed, only the "start-game" action is valid.
    if (!rulesState.hasDealt) {
      if (intent.type !== "action" || intent.action !== "start-game") {
        return {
          valid: false,
          reason:
            "The game has not been dealt yet. Use the 'Start Game' action.",
          engineEvents: [],
        };
      }

      const nextDealNumber = rulesState.dealNumber + 1;

      // Gather all cards back to deck explicitly (avoid using 'any')
      engineEvents.push(
        ...gatherAllCards(state, { previousEvents: engineEvents })
      );

      // SHUFFLE all cards deterministically
      const shuffledCardIds = shuffleAllCards(
        state,
        nextDealNumber,
        "BRISCOLA",
        { useCurrentDeckIfFull: false }
      );

      nextRulesState = {
        ...rulesState,
        hasDealt: true,
        dealNumber: nextDealNumber,
        phase: "playing",
        currentTrick: null,
      };

      // Deal from the shuffled deck directly (Option A)
      const players = nextRulesState.players;
      const { events: dealEvents, nextIndex: afterDealIdx } =
        distributeRoundRobin(
          shuffledCardIds,
          players.map((p) => `${p}-hand`),
          3
        );
      engineEvents.push(...dealEvents);

      // Flip next card as briscola
      const briscolaCardId = shuffledCardIds[afterDealIdx];
      engineEvents.push({
        type: "move-cards",
        fromPileId: "deck",
        toPileId: "briscola",
        cardIds: [briscolaCardId],
      });

      // Determine briscola suit from the flipped card
      const briscolaCard = state.allCards[briscolaCardId];
      nextRulesState.briscolaSuit = briscolaCard?.suit ?? null;

      // If we finished a hand, the rules state will have been reset to deal.
      // We pass the final hand result as a summary to collapse the history.
      nextRulesState.agentGuide = appendHistoryDigest(
        nextRulesState.agentGuide,
        `Hand ${nextDealNumber} started (briscola ${nextRulesState.briscolaSuit ?? "unknown"}).`,
        { summarizePrevious: rulesState.result || undefined }
      );

      // First player to act: take the first configured player (defaults to P1)
      const firstPlayer = rulesState.players[0] ?? null;
      engineEvents.push({
        type: "set-current-player",
        player: firstPlayer,
      });

      engineEvents.push(
        computeCardVisuals(state, nextRulesState, engineEvents)
      );

      const projected = projectPilesAfterEvents(state, engineEvents);
      const scoreboard = buildScoreboard(projected, nextRulesState);

      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: [scoreboard],
      });

      engineEvents.push({
        type: "set-rules-state",
        rulesState: nextRulesState,
      });

      return { valid: true, engineEvents };
    }

    // From here on, the game has been dealt.
    if (rulesState.phase === "ended") {
      return {
        valid: false,
        reason: "Game has already ended.",
        engineEvents: [],
      };
    }

    if (intent.type !== "move") {
      return {
        valid: false,
        reason: "Briscola only supports playing cards as move intents.",
        engineEvents: [],
      };
    }

    // Basic ownership checks
    const playerId = intent.playerId;
    if (!playerId || !players.includes(playerId)) {
      return {
        valid: false,
        reason: "Unknown or invalid player.",
        engineEvents: [],
      };
    }

    if (state.currentPlayer && state.currentPlayer !== playerId) {
      return {
        valid: false,
        reason: "It is not your turn.",
        engineEvents: [],
      };
    }

    if (
      intent.fromPileId !== `${playerId}-hand` ||
      intent.toPileId !== "trick"
    ) {
      return {
        valid: false,
        reason:
          "In Briscola, you must play cards from your hand to the trick pile.",
        engineEvents: [],
      };
    }

    const handPile = state.piles[`${playerId}-hand`];
    if (!handPile || !handPile.cards) {
      return {
        valid: false,
        reason: "Your hand is not available.",
        engineEvents: [],
      };
    }

    const played = handPile.cards.find((c) => c.id === intent.cardId);
    if (!played) {
      return {
        valid: false,
        reason: "Card not in source pile.",
        engineEvents: [],
      };
    }

    // Always move played card hand -> trick first
    engineEvents.push({
      type: "move-cards",
      fromPileId: `${playerId}-hand`,
      toPileId: "trick",
      cardIds: [intent.cardId],
    });

    // Create the array with proper typing
    const playedCard: SimpleCard & { playedBy?: string | null } = {
      ...played,
      playedBy: playerId,
    };

    // Use rulesState.currentTrick to reconstruct trick cards
    const trickCardsFromState = (rulesState.currentTrick ?? [])
      .map((entry) => {
        const card = state.allCards[entry.cardId];
        return card ? { ...card, playedBy: entry.playedBy } : null;
      })
      .filter((c): c is SimpleCard & { playedBy: string } => c !== null);

    const trickCardsAfterMove = [...trickCardsFromState, playedCard];

    // If this completes the trick (2 cards), determine winner
    if (trickCardsAfterMove.length === 2) {
      const winner = determineTrickWinner(
        trickCardsAfterMove,
        rulesState.briscolaSuit
      );
      nextRulesState.agentGuide = appendHistoryDigest(
        nextRulesState.agentGuide,
        formatTrickSummary(trickCardsAfterMove, winner)
      );
      const cardIds = trickCardsAfterMove.map((c) => c.id) as [
        number,
        ...number[],
      ];

      // Move all trick cards to winner's won pile
      engineEvents.push({
        type: "move-cards",
        fromPileId: "trick",
        toPileId: `${winner}-won`,
        cardIds,
      });

      // Winner of the trick leads the next trick
      const nextPlayer: string | null = winner;

      // Reset current trick since it's completed
      nextRulesState.currentTrick = null;

      // Draw logic
      let projected = projectPilesAfterEvents(state, engineEvents);
      const drawEvents = refillHands(projected, nextRulesState, winner);
      if (drawEvents.length > 0) {
        engineEvents.push(...drawEvents);
        projected = projectPilesAfterEvents(state, engineEvents);
      }

      // Check if game is ended (both hands are now empty)
      const p1Hand = projected["P1-hand"];
      const p2Hand = projected["P2-hand"];
      const bothHandsEmpty =
        (!p1Hand || p1Hand.size === 0) && (!p2Hand || p2Hand.size === 0);

      if (bothHandsEmpty) {
        // End game - calculate final scores
        const finalScores = computeScores(projected, nextRulesState);
        const scoreLine = players
          .map((p) => `${p}: ${finalScores[p].points} pts`)
          .join(", ");

        nextRulesState.result = `Hand ${nextRulesState.dealNumber} Result: ${scoreLine}.`;
        nextRulesState.phase = "ended";
        nextRulesState.hasDealt = false; // trigger next round overlay

        const finalScoreboard = buildScoreboard(projected, nextRulesState);
        const winnerId = determineWinner(projected, nextRulesState);

        engineEvents.push({
          type: "set-scoreboards",
          scoreboards: [finalScoreboard],
        });

        if (winnerId) {
          engineEvents.push({
            type: "set-winner",
            winner: winnerId,
          });
        }
      } else {
        // Continue playing
        engineEvents.push({
          type: "set-current-player",
          player: nextPlayer,
        });
      }
    } else {
      // Trick not complete yet, wait for opponent
      const nextPlayer: string | null = getOtherPlayer(playerId, players);
      engineEvents.push({
        type: "set-current-player",
        player: nextPlayer,
      });

      nextRulesState.currentTrick = [
        ...(rulesState.currentTrick || []),
        { cardId: intent.cardId, playedBy: playerId },
      ];
    }

    // Card visuals for briscola rotation
    engineEvents.push(computeCardVisuals(state, nextRulesState, engineEvents));

    // Update scoreboard
    const finalProjected = projectPilesAfterEvents(state, engineEvents);
    const scoreboard = buildScoreboard(finalProjected, nextRulesState);
    engineEvents.push({
      type: "set-scoreboards",
      scoreboards: [scoreboard],
    });

    engineEvents.push({
      type: "set-rules-state",
      rulesState: nextRulesState,
    });

    return { valid: true, engineEvents };
  },
};

export const briscolaPlugin: GamePlugin = {
  id: "briscola",
  gameName: META.gameName,
  ruleModule: briscolaRules,
  description: META.description,
  validationHints: {
    // We need to see trick contents for winner determination
    // and deck for initial dealing
    sharedPileIds: ["trick", "briscola", "deck"],
  } satisfies ValidationHints,
};
