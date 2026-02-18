/**
 * Cribbage (Six-Card) - Rule Module
 *
 * Standard two-player Cribbage where players score for:
 * - During play: pairs, runs, 15s, 31s, last card
 * - In hands/crib: 15s, pairs, runs, flushes, "his nob"
 *
 * First to 121 points wins.
 */

import type { GameRuleModule, GamePlugin } from "../interface.js";
import type { ValidationState } from "../../validation-state.js";
import type {
  ClientIntent,
  Card,
  Scoreboard,
  ScoreboardCell,
  ActionGrid,
  ActionCell,
} from "../../../../shared/schemas.js";
import type { EngineEvent } from "../../../../shared/validation.js";
import {
  gatherAllCards,
  shuffleAllCards,
  distributeRoundRobin,
} from "../util/dealing.js";

// ============================================================================
// Types
// ============================================================================

type Phase = "initial" | "discard" | "play" | "show" | "complete";

interface CribbageRulesState {
  phase: Phase;
  hasDealt: boolean;
  dealNumber: number;
  dealer: string;
  scores: Record<string, number>;
  playCount: number;
  playTotal: number;
  lastPlayedBy: string | null;
  cannotPlay: string[];
  starterSuit: string | null;
  currentRoundCards: string[]; // Card IDs in the current play round (resets after Go/31)
  playedCardsByPlayer: Record<string, number[]>;
}

// ============================================================================
// Constants
// ============================================================================

const WINNING_SCORE = 121;

const RANK_VALUES: Record<string, number> = {
  A: 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  J: 10,
  Q: 10,
  K: 10,
};

const RANK_ORDER = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
];

// ============================================================================
// Helper Functions
// ============================================================================

function getPlayerIds(players: Array<{ id: string; name: string }>): string[] {
  return players.map((p) => p.id);
}

function getOtherPlayer(
  playerId: string,
  players: Array<{ id: string; name: string }>
): string {
  const playerIds = getPlayerIds(players);
  return playerIds.find((p) => p !== playerId)!;
}

function getNonDealer(
  dealer: string,
  players: Array<{ id: string; name: string }>
): string {
  return getOtherPlayer(dealer, players);
}

function cardValue(card: Card): number {
  return RANK_VALUES[card.rank] || 0;
}

function rankIndex(rank: string): number {
  return RANK_ORDER.indexOf(rank);
}

/**
 * Calculate points during the play phase for the current play sequence.
 */
function calculatePlayScore(
  playedCards: Card[],
  playTotal: number
): Array<{ reason: string; points: number }> {
  const scores: Array<{ reason: string; points: number }> = [];

  if (playedCards.length === 0) return scores;

  const lastCard = playedCards[playedCards.length - 1]!;

  // Check for 15
  if (playTotal === 15) {
    scores.push({ reason: "Fifteen", points: 2 });
  }

  // Check for 31
  if (playTotal === 31) {
    scores.push({ reason: "Thirty-one", points: 2 });
  }

  // Check for pairs (2, 3, or 4 of a kind in a row)
  if (playedCards.length >= 2) {
    const lastRank = lastCard.rank;
    let pairCount = 1;
    for (let i = playedCards.length - 2; i >= 0; i--) {
      if (playedCards[i]!.rank === lastRank) {
        pairCount++;
      } else {
        break;
      }
    }

    if (pairCount === 2) {
      scores.push({ reason: "Pair", points: 2 });
    } else if (pairCount === 3) {
      scores.push({ reason: "Pair royal", points: 6 });
    } else if (pairCount === 4) {
      scores.push({ reason: "Double pair royal", points: 12 });
    }
  }

  // Check for runs (3+ consecutive cards in any order at the end)
  if (playedCards.length >= 3) {
    for (let len = playedCards.length; len >= 3; len--) {
      const subset = playedCards.slice(-len);
      const ranks = subset.map((c) => c.rank);
      const indices = ranks.map(rankIndex).sort((a, b) => a - b);

      let isRun = true;
      for (let i = 1; i < indices.length; i++) {
        if (indices[i] !== indices[i - 1]! + 1) {
          isRun = false;
          break;
        }
      }

      if (isRun) {
        scores.push({ reason: `Run of ${len}`, points: len });
        break;
      }
    }
  }

  return scores;
}

/**
 * Score a hand (or crib) with the starter card.
 */
function scoreHand(
  handCards: Card[],
  starterCard: Card | null,
  isCrib: boolean
): { points: number; breakdown: string[] } {
  let points = 0;
  const breakdown: string[] = [];

  if (!starterCard) {
    return { points: 0, breakdown: ["No starter card"] };
  }

  const allCards = [...handCards, starterCard];

  // 15s
  const fifteens = countFifteens(allCards);
  if (fifteens > 0) {
    points += fifteens * 2;
    breakdown.push(
      `${fifteens} fifteen${fifteens > 1 ? "s" : ""} (${fifteens * 2} pts)`
    );
  }

  // Pairs
  const pairPoints = countPairs(allCards);
  if (pairPoints > 0) {
    points += pairPoints;
    breakdown.push(`Pairs (${pairPoints} pts)`);
  }

  // Runs
  const runPoints = countRuns(allCards);
  if (runPoints > 0) {
    points += runPoints;
    breakdown.push(`Runs (${runPoints} pts)`);
  }

  // Flush
  const flushPoints = countFlush(handCards, starterCard, isCrib);
  if (flushPoints > 0) {
    points += flushPoints;
    breakdown.push(`Flush (${flushPoints} pts)`);
  }

  // His nob
  const nobPoints = countNob(handCards, starterCard);
  if (nobPoints > 0) {
    points += nobPoints;
    breakdown.push("His nob (1 pt)");
  }

  if (breakdown.length === 0) {
    breakdown.push("0 points");
  }

  return { points, breakdown };
}

function countFifteens(cards: Card[]): number {
  let count = 0;
  const n = cards.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        sum += cardValue(cards[i]!);
      }
    }
    if (sum === 15) count++;
  }
  return count;
}

function countPairs(cards: Card[]): number {
  let points = 0;
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      if (cards[i]!.rank === cards[j]!.rank) {
        points += 2;
      }
    }
  }
  return points;
}

function countRuns(cards: Card[]): number {
  const n = cards.length;
  let bestRunLength = 0;
  let runsOfBestLength = 0;

  for (let mask = 1; mask < 1 << n; mask++) {
    const subset: Card[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) subset.push(cards[i]!);
    }

    if (subset.length < 3) continue;

    const indices = subset.map((c) => rankIndex(c.rank)).sort((a, b) => a - b);
    let isRun = true;
    for (let i = 1; i < indices.length; i++) {
      if (indices[i] !== indices[i - 1]! + 1) {
        isRun = false;
        break;
      }
    }

    if (isRun) {
      if (subset.length > bestRunLength) {
        bestRunLength = subset.length;
        runsOfBestLength = 1;
      } else if (subset.length === bestRunLength) {
        runsOfBestLength++;
      }
    }
  }

  return bestRunLength * runsOfBestLength;
}

function countFlush(
  handCards: Card[],
  starterCard: Card,
  isCrib: boolean
): number {
  if (handCards.length === 0) return 0;

  const handSuit = handCards[0]!.suit;
  const allHandSameSuit = handCards.every((c) => c.suit === handSuit);

  if (!allHandSameSuit) return 0;

  if (isCrib) {
    if (starterCard.suit === handSuit) {
      return 5;
    }
    return 0;
  } else {
    if (starterCard.suit === handSuit) {
      return 5;
    }
    return 4;
  }
}

function countNob(handCards: Card[], starterCard: Card): number {
  for (const card of handCards) {
    if (card.rank === "J" && card.suit === starterCard.suit) {
      return 1;
    }
  }
  return 0;
}

function normalizePlayedCardsByPlayer(
  rs: CribbageRulesState,
  players: Array<{ id: string; name: string }>
): Record<string, number[]> {
  const next: Record<string, number[]> = {};
  for (const player of players) {
    next[player.id] = [...(rs.playedCardsByPlayer?.[player.id] ?? [])];
  }
  return next;
}

function createEmptyPlayedCardsByPlayer(
  players: Array<{ id: string; name: string }>
): Record<string, number[]> {
  const next: Record<string, number[]> = {};
  for (const player of players) {
    next[player.id] = [];
  }
  return next;
}

function cardsFromIds(
  ids: number[],
  allCards: Record<number, { id: number; rank: string; suit: string }>
): Card[] {
  return ids.map((id) => {
    const card = allCards[id];
    if (!card) {
      return { id, rank: "unknown", suit: "unknown" };
    }
    return { id: card.id, rank: card.rank, suit: card.suit };
  });
}

function pushCribRevealEvents(engineEvents: EngineEvent[]) {
  engineEvents.push({
    type: "set-pile-visibility",
    pileId: "crib",
    visibility: "public",
  });
  engineEvents.push({
    type: "set-pile-properties",
    properties: {
      crib: { layout: "horizontal" },
    },
  });
}

function pushCribHideEvents(engineEvents: EngineEvent[]) {
  engineEvents.push({
    type: "set-pile-visibility",
    pileId: "crib",
    visibility: "hidden",
  });
  engineEvents.push({
    type: "set-pile-properties",
    properties: {},
  });
}

// ============================================================================
// Derive Actions and Scoreboards
// ============================================================================

function deriveActions(
  state: ValidationState,
  rs: CribbageRulesState,
  currentPlayer: string | null
): ActionGrid {
  const cells: ActionCell[] = [];

  // Show phase: show "Show Hands" button to trigger scoring
  if (rs.phase === "show") {
    cells.push({
      row: 0,
      col: 0,
      id: "show",
      label: "Show Hands",
      enabled: true,
    });
    return { rows: 1, cols: 1, cells };
  }

  // Play phase: show "Go" button if current player has no valid plays
  if (rs.phase === "play" && currentPlayer) {
    // If player already said "Go", no button needed (waiting for other player)
    if (rs.cannotPlay.includes(currentPlayer)) {
      return { rows: 0, cols: 0, cells: [] };
    }

    // Check if player has any playable cards (when hand is visible).
    const hand = state.piles[`${currentPlayer}-hand`];
    if (hand?.cards) {
      const hasPlayableCard = hand.cards.some(
        (card) => rs.playTotal + cardValue(card) <= 31
      );

      // If no playable cards, show "Go" button.
      if (!hasPlayableCard) {
        cells.push({
          row: 0,
          col: 0,
          id: "go",
          label: "Go",
          enabled: true,
        });
        return { rows: 1, cols: 1, cells };
      }

      // Player has playable cards, no need to show "Go".
      return { rows: 0, cols: 0, cells: [] };
    }

    // If we can't see the current player's hand (hidden to the actor who moved),
    // still offer "Go" to avoid deadlocks.
    cells.push({
      row: 0,
      col: 0,
      id: "go",
      label: "Go",
      enabled: true,
    });
    return { rows: 1, cols: 1, cells };
  }

  // All other phases/situations: no action buttons
  return { rows: 0, cols: 0, cells: [] };
}

function deriveScoreboards(rs: CribbageRulesState): Scoreboard[] {
  const cells: ScoreboardCell[] = [];
  const countLabel = rs.phase === "play" ? `Count ${rs.playTotal}` : "";

  // Header row with player names and scores
  cells.push({
    row: 0,
    col: 0,
    text: `P1 (${rs.scores["P1"] || 0})`,
    role: "header",
    align: "center",
    colspan: 2,
  });
  // Middle separator column
  cells.push({
    row: 0,
    col: 2,
    text: countLabel,
    role: "header",
    align: "center",
  });
  cells.push({
    row: 0,
    col: 3,
    text: `P2 (${rs.scores["P2"] || 0})`,
    role: "header",
    align: "center",
    colspan: 2,
  });

  const p1Score = rs.scores["P1"] || 0;
  const p2Score = rs.scores["P2"] || 0;

  // Create a cribbage board layout similar to the real board
  // 61 rows to show positions 0-120 (two columns per player + separator)
  // P1: column 0 goes 0->60, column 1 goes 120->61 (descending)
  // Middle: column 2 is empty separator
  // P2: column 3 goes 0->60, column 4 goes 120->61 (descending)
  const halfWay = 60;

  for (let row = 0; row <= halfWay; row++) {
    const rowIndex = row + 1; // +1 for header

    // P1 first column (positions 0-60, ascending)
    const p1Pos1 = row;
    let p1Text1 = "○";
    if (p1Score === p1Pos1) {
      p1Text1 = "●";
    } else if (p1Pos1 % 10 === 0) {
      p1Text1 = String(p1Pos1);
    }
    cells.push({
      row: rowIndex,
      col: 0,
      text: p1Text1,
      role: "body",
      align: "center",
    });

    // P1 second column (positions 120->61, descending from top)
    const p1Pos2 = WINNING_SCORE - 1 - row;
    let p1Text2 = "○";
    if (p1Score === p1Pos2) {
      p1Text2 = "●";
    } else if (p1Pos2 % 10 === 0) {
      p1Text2 = String(p1Pos2);
    }
    cells.push({
      row: rowIndex,
      col: 1,
      text: p1Text2,
      role: "body",
      align: "center",
    });

    // Middle separator column (vertical line)
    cells.push({
      row: rowIndex,
      col: 2,
      text: "",
      role: "separator",
      align: "center",
    });

    // P2 first column (positions 0-60, ascending)
    const p2Pos1 = row;
    let p2Text1 = "○";
    if (p2Score === p2Pos1) {
      p2Text1 = "●";
    } else if (p2Pos1 % 10 === 0) {
      p2Text1 = String(p2Pos1);
    }
    cells.push({
      row: rowIndex,
      col: 3,
      text: p2Text1,
      role: "body",
      align: "center",
    });

    // P2 second column (positions 120->61, descending from top)
    const p2Pos2 = WINNING_SCORE - 1 - row;
    let p2Text2 = "○";
    if (p2Score === p2Pos2) {
      p2Text2 = "●";
    } else if (p2Pos2 % 10 === 0) {
      p2Text2 = String(p2Pos2);
    }
    cells.push({
      row: rowIndex,
      col: 4,
      text: p2Text2,
      role: "body",
      align: "center",
    });
  }

  return [
    {
      id: "cribbage-board",
      title: "Cribbage Board",
      rows: halfWay + 2, // 62 rows: header + 61 data rows (0-60)
      cols: 5, // 5 columns: P1 (2) + separator (1) + P2 (2)
      cells,
    },
  ];
}

// ============================================================================
// Rule Module
// ============================================================================

export const cribbageRuleModule: GameRuleModule = {
  listLegalIntentsForPlayer(state: ValidationState, playerId: string) {
    const intents: ClientIntent[] = [];
    const rs = state.rulesState as CribbageRulesState;

    if (rs.phase === "initial" && !rs.hasDealt) {
      intents.push({
        type: "action",
        gameId: state.gameId,
        playerId,
        action: "start-game",
      });
      return intents;
    }

    if (state.currentPlayer && state.currentPlayer !== playerId) {
      return intents;
    }

    if (rs.phase === "discard") {
      const hand = state.piles[`${playerId}-hand`];
      if (hand && hand.cards && hand.cards.length > 4) {
        // Player can discard any card from hand (one at a time)
        for (const card of hand.cards) {
          intents.push({
            type: "move",
            gameId: state.gameId,
            playerId,
            fromPileId: `${playerId}-hand`,
            toPileId: "crib",
            cardId: card.id,
          });
        }
      }
    } else if (rs.phase === "play") {
      const hand = state.piles[`${playerId}-hand`];
      if (!hand || !hand.cards) return intents;

      if (rs.cannotPlay.includes(playerId)) {
        return intents;
      }

      for (const card of hand.cards) {
        const newTotal = rs.playTotal + cardValue(card);
        if (newTotal <= 31) {
          intents.push({
            type: "move",
            gameId: state.gameId,
            playerId,
            fromPileId: `${playerId}-hand`,
            toPileId: "play",
            cardId: card.id,
          });
        }
      }

      if (intents.length === 0) {
        intents.push({
          type: "action",
          gameId: state.gameId,
          playerId,
          action: "go",
        });
      }
    } else if (rs.phase === "show") {
      // Show phase: any player can trigger scoring (fully automatic)
      intents.push({
        type: "action",
        gameId: state.gameId,
        playerId,
        action: "show",
      });
    }

    return intents;
  },

  validate(state: ValidationState, intent: ClientIntent) {
    const engineEvents: EngineEvent[] = [];
    const rs = state.rulesState as CribbageRulesState;
    const players = state.players;

    if (state.winner) {
      return {
        valid: false,
        reason: "Game is already finished",
        engineEvents: [],
      };
    }

    // ========================================================================
    // PHASE: initial (start-game)
    // ========================================================================
    if (rs.phase === "initial") {
      if (intent.type !== "action" || intent.action !== "start-game") {
        return {
          valid: false,
          reason:
            "The game has not been started yet. Use the 'Start Game' action.",
          engineEvents: [],
        };
      }

      pushCribHideEvents(engineEvents);

      if (rs.dealNumber > 0) {
        engineEvents.push(
          ...gatherAllCards(state, { previousEvents: engineEvents })
        );

        const shuffledCardIds = shuffleAllCards(
          state,
          rs.dealNumber,
          "CRIBBAGE",
          { useCurrentDeckIfFull: false }
        );

        const { events: dealEvents } = distributeRoundRobin(
          shuffledCardIds,
          ["P1-hand", "P2-hand"],
          6
        );
        engineEvents.push(...dealEvents);
      } else {
        const deckPile = state.piles["deck"];
        if (!deckPile || !deckPile.cards || deckPile.cards.length < 12) {
          return {
            valid: false,
            reason: "Deck does not have enough cards to deal",
            engineEvents: [],
          };
        }

        const cards = [...deckPile.cards];
        for (let i = 0; i < 6; i++) {
          engineEvents.push({
            type: "move-cards",
            fromPileId: "deck",
            toPileId: "P1-hand",
            cardIds: [cards[i * 2]!.id],
          });
          engineEvents.push({
            type: "move-cards",
            fromPileId: "deck",
            toPileId: "P2-hand",
            cardIds: [cards[i * 2 + 1]!.id],
          });
        }
      }

      const nextRs: CribbageRulesState = {
        ...rs,
        phase: "discard",
        hasDealt: true,
        playCount: 0,
        playTotal: 0,
        lastPlayedBy: null,
        cannotPlay: [],
        starterSuit: null,
        currentRoundCards: [],
        playedCardsByPlayer: createEmptyPlayedCardsByPlayer(players),
      };

      const nonDealer = getNonDealer(rs.dealer, players);

      engineEvents.push({ type: "set-rules-state", rulesState: nextRs });
      engineEvents.push({ type: "set-current-player", player: nonDealer });
      engineEvents.push({
        type: "set-actions",
        actions: deriveActions(state, nextRs, nonDealer),
      });
      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: deriveScoreboards(nextRs),
      });

      return { valid: true, engineEvents };
    }

    // ========================================================================
    // PHASE: discard
    // ========================================================================
    if (rs.phase === "discard") {
      if (state.currentPlayer && state.currentPlayer !== intent.playerId) {
        return {
          valid: false,
          reason: "It's not your turn.",
          engineEvents: [],
        };
      }

      if (intent.type !== "move") {
        return {
          valid: false,
          reason: "You must discard cards to the crib.",
          engineEvents: [],
        };
      }

      const { fromPileId, toPileId, cardId } = intent;
      if (fromPileId !== `${intent.playerId}-hand` || toPileId !== "crib") {
        return {
          valid: false,
          reason: "You must discard cards from your hand to the crib.",
          engineEvents: [],
        };
      }

      if (!cardId) {
        return {
          valid: false,
          reason: "You must select a card to discard.",
          engineEvents: [],
        };
      }

      const handPile = state.piles[fromPileId];
      if (!handPile || !handPile.cards) {
        return {
          valid: false,
          reason: "Hand pile not found.",
          engineEvents: [],
        };
      }

      // Check that player hasn't already discarded both cards
      if (handPile.cards.length < 5) {
        return {
          valid: false,
          reason: "You have already discarded both cards.",
          engineEvents: [],
        };
      }

      engineEvents.push({
        type: "move-cards",
        fromPileId,
        toPileId,
        cardIds: [cardId],
      });

      // Calculate pile sizes AFTER this move
      const p1Hand = state.piles["P1-hand"];
      const p2Hand = state.piles["P2-hand"];
      const cribPile = state.piles["crib"];

      const p1Remaining =
        (p1Hand?.size || 6) - (fromPileId === "P1-hand" ? 1 : 0);
      const p2Remaining =
        (p2Hand?.size || 6) - (fromPileId === "P2-hand" ? 1 : 0);
      const cribSize = (cribPile?.size || 0) + 1;

      if (p1Remaining === 4 && p2Remaining === 4 && cribSize === 4) {
        // Both players have discarded 2 cards each, cut the starter
        const deckPile = state.piles["deck"];
        if (!deckPile || !deckPile.cards || deckPile.cards.length === 0) {
          return {
            valid: false,
            reason: "Deck is empty, cannot cut starter.",
            engineEvents: [],
          };
        }

        const starterCard = deckPile.cards[0]!;
        engineEvents.push({
          type: "move-cards",
          fromPileId: "deck",
          toPileId: "starter",
          cardIds: [starterCard.id],
        });

        const nextRs: CribbageRulesState = {
          ...rs,
          phase: "play",
          playCount: 0,
          playTotal: 0,
          lastPlayedBy: null,
          cannotPlay: [],
          starterSuit: starterCard.suit,
          currentRoundCards: [],
          playedCardsByPlayer: createEmptyPlayedCardsByPlayer(players),
        };

        const newScores = { ...rs.scores };

        // Check for "his heels" (starter is Jack, dealer scores 2)
        if (starterCard.rank === "J") {
          newScores[rs.dealer] = (newScores[rs.dealer] || 0) + 2;
          engineEvents.push({
            type: "announce",
            text: `${rs.dealer}: His heels (2 pts)`,
            anchor: {
              type: "pile",
              pileId: "starter",
            },
          });
        }

        nextRs.scores = newScores;

        // Non-dealer plays first
        const nonDealer = getNonDealer(rs.dealer, players);
        engineEvents.push({ type: "set-rules-state", rulesState: nextRs });
        engineEvents.push({ type: "set-current-player", player: nonDealer });
        engineEvents.push({
          type: "set-actions",
          actions: deriveActions(state, nextRs, nonDealer),
        });
        engineEvents.push({
          type: "set-scoreboards",
          scoreboards: deriveScoreboards(nextRs),
        });

        // Check for win
        if (newScores[rs.dealer]! >= WINNING_SCORE) {
          engineEvents.push({ type: "set-winner", winner: rs.dealer });
        }
      } else {
        // Check if current player has discarded both cards (hand now has 4)
        const currentPlayerHandSize =
          fromPileId === "P1-hand" ? p1Remaining : p2Remaining;

        if (currentPlayerHandSize === 4) {
          // Current player has discarded both cards, switch to other player
          const nextPlayer = getOtherPlayer(intent.playerId, players);
          const nextRs = { ...rs };

          engineEvents.push({ type: "set-rules-state", rulesState: nextRs });
          engineEvents.push({ type: "set-current-player", player: nextPlayer });
          engineEvents.push({
            type: "set-actions",
            actions: deriveActions(state, nextRs, nextPlayer),
          });
          engineEvents.push({
            type: "set-scoreboards",
            scoreboards: deriveScoreboards(nextRs),
          });
        } else {
          // Current player still needs to discard one more card, keep their turn
          const nextRs = { ...rs };

          engineEvents.push({ type: "set-rules-state", rulesState: nextRs });
          engineEvents.push({
            type: "set-current-player",
            player: intent.playerId,
          });
          engineEvents.push({
            type: "set-actions",
            actions: deriveActions(state, nextRs, intent.playerId),
          });
          engineEvents.push({
            type: "set-scoreboards",
            scoreboards: deriveScoreboards(nextRs),
          });
        }
      }

      return { valid: true, engineEvents };
    }

    // ========================================================================
    // PHASE: play
    // ========================================================================
    if (rs.phase === "play") {
      if (state.currentPlayer && state.currentPlayer !== intent.playerId) {
        return {
          valid: false,
          reason: "It's not your turn.",
          engineEvents: [],
        };
      }

      if (intent.type === "action" && intent.action === "go") {
        // Player says "go"
        if (rs.cannotPlay.includes(intent.playerId)) {
          return {
            valid: false,
            reason: "You have already said 'go'.",
            engineEvents: [],
          };
        }

        const hand = state.piles[`${intent.playerId}-hand`];
        if (hand?.cards) {
          const hasPlayableCard = hand.cards.some(
            (card) => rs.playTotal + cardValue(card) <= 31
          );
          if (hasPlayableCard) {
            return {
              valid: false,
              reason: "You have a playable card.",
              engineEvents: [],
            };
          }
        }

        const nextCannotPlay = [...rs.cannotPlay, intent.playerId];
        const otherPlayer = getOtherPlayer(intent.playerId, players);

        // Check if other player also cannot play
        if (nextCannotPlay.includes(otherPlayer)) {
          // Both players cannot play, award "last card" point and reset
          const lastPlayer = rs.lastPlayedBy || intent.playerId;
          const newScores = { ...rs.scores };

          if (rs.playTotal !== 31) {
            // Award 1 point for last card (31 was already scored when the card was played)
            newScores[lastPlayer] = (newScores[lastPlayer] || 0) + 1;
            engineEvents.push({
              type: "announce",
              text: `${lastPlayer}: Last card (1 pt)`,
              anchor: {
                type: "pile",
                pileId: "play",
              },
            });
          }

          // Check if all cards have been played
          const p1HandPile = state.piles["P1-hand"];
          const p2HandPile = state.piles["P2-hand"];

          const p1Remaining = p1HandPile?.size || 0;
          const p2Remaining = p2HandPile?.size || 0;

          if (p1Remaining === 0 && p2Remaining === 0) {
            // All cards played, move to show phase
            const nextRs: CribbageRulesState = {
              ...rs,
              phase: "show",
              scores: newScores,
            };

            pushCribRevealEvents(engineEvents);

            const nonDealer = getNonDealer(rs.dealer, players);
            engineEvents.push({ type: "set-rules-state", rulesState: nextRs });
            engineEvents.push({
              type: "set-current-player",
              player: nonDealer,
            });
            engineEvents.push({
              type: "set-actions",
              actions: deriveActions(state, nextRs, nonDealer),
            });
            engineEvents.push({
              type: "set-scoreboards",
              scoreboards: deriveScoreboards(nextRs),
            });

            // Check for win
            if (newScores[lastPlayer]! >= WINNING_SCORE) {
              engineEvents.push({ type: "set-winner", winner: lastPlayer });
            }
          } else {
            // Reset play total and continue with player who has cards
            const nextRs: CribbageRulesState = {
              ...rs,
              playTotal: 0,
              cannotPlay: [],
              lastPlayedBy: null,
              scores: newScores,
              currentRoundCards: [],
            };

            const lastPlayerHandSize =
              state.piles[`${lastPlayer}-hand`]?.size ?? 0;
            const otherPlayerOfLast = getOtherPlayer(lastPlayer, players);
            const otherPlayerHandSize =
              state.piles[`${otherPlayerOfLast}-hand`]?.size ?? 0;
            const nextPlayer =
              lastPlayerHandSize > 0
                ? lastPlayer
                : otherPlayerHandSize > 0
                  ? otherPlayerOfLast
                  : lastPlayer;
            engineEvents.push({ type: "set-rules-state", rulesState: nextRs });
            engineEvents.push({
              type: "set-current-player",
              player: nextPlayer,
            });
            engineEvents.push({
              type: "set-actions",
              actions: deriveActions(state, nextRs, nextPlayer),
            });
            engineEvents.push({
              type: "set-scoreboards",
              scoreboards: deriveScoreboards(nextRs),
            });

            // Check for win
            if (newScores[lastPlayer]! >= WINNING_SCORE) {
              engineEvents.push({ type: "set-winner", winner: lastPlayer });
            }
          }
        } else {
          // Other player continues
          const nextRs: CribbageRulesState = {
            ...rs,
            cannotPlay: nextCannotPlay,
          };

          engineEvents.push({ type: "set-rules-state", rulesState: nextRs });
          engineEvents.push({
            type: "set-current-player",
            player: otherPlayer,
          });
          engineEvents.push({
            type: "set-actions",
            actions: deriveActions(state, nextRs, otherPlayer),
          });
          engineEvents.push({
            type: "set-scoreboards",
            scoreboards: deriveScoreboards(nextRs),
          });
        }

        return { valid: true, engineEvents };
      }

      if (intent.type !== "move") {
        return {
          valid: false,
          reason: "You must play a card from your hand.",
          engineEvents: [],
        };
      }

      const { fromPileId, toPileId, cardId } = intent;

      if (fromPileId !== `${intent.playerId}-hand`) {
        return {
          valid: false,
          reason: "You can only play cards from your hand.",
          engineEvents: [],
        };
      }

      if (toPileId !== "play") {
        return {
          valid: false,
          reason: "You must play cards to the play pile.",
          engineEvents: [],
        };
      }

      const handPile = state.piles[fromPileId];
      if (!handPile || !handPile.cards) {
        return {
          valid: false,
          reason: "Hand pile not found.",
          engineEvents: [],
        };
      }

      const card = handPile.cards.find((c) => c.id === cardId);
      if (!card) {
        return {
          valid: false,
          reason: "Card not found in hand.",
          engineEvents: [],
        };
      }

      const newTotal = rs.playTotal + cardValue(card);
      if (newTotal > 31) {
        return {
          valid: false,
          reason: "Playing this card would exceed 31.",
          engineEvents: [],
        };
      }

      // Player can play, so remove them from cannotPlay if they were there
      const nextCannotPlay = rs.cannotPlay.filter((p) => p !== intent.playerId);

      engineEvents.push({
        type: "move-cards",
        fromPileId,
        toPileId: "play",
        cardIds: [cardId!],
      });

      // Announce the count over the player's play pile
      engineEvents.push({
        type: "announce",
        text: `Count: ${newTotal}`,
        anchor: {
          type: "pile",
          pileId: "play",
        },
      });

      // Build play sequence from current round cards only
      const currentRoundCardIds = [...rs.currentRoundCards, String(cardId!)];
      const playSequence: Card[] = [];

      const playPile = state.piles["play"];
      for (const cid of currentRoundCardIds) {
        const foundCard = playPile?.cards?.find((c) => String(c.id) === cid);
        if (foundCard) playSequence.push(foundCard);
      }
      // Add the card being played
      playSequence.push(card);

      const playScores = calculatePlayScore(playSequence, newTotal);
      const newScores = { ...rs.scores };
      for (const { reason, points } of playScores) {
        newScores[intent.playerId] = (newScores[intent.playerId] || 0) + points;
        engineEvents.push({
          type: "announce",
          text: `${intent.playerId}: ${reason} (${points} pts)`,
          anchor: {
            type: "pile",
            pileId: "play",
          },
        });
      }

      const playedCardsByPlayer = normalizePlayedCardsByPlayer(rs, players);
      playedCardsByPlayer[intent.playerId] = [
        ...(playedCardsByPlayer[intent.playerId] ?? []),
        card.id,
      ];

      const isThirtyOne = newTotal === 31;
      const nextRs: CribbageRulesState = {
        ...rs,
        playCount: rs.playCount + 1,
        playTotal: isThirtyOne ? 0 : newTotal,
        lastPlayedBy: isThirtyOne ? null : intent.playerId,
        cannotPlay: isThirtyOne ? [] : nextCannotPlay,
        scores: newScores,
        currentRoundCards: isThirtyOne ? [] : currentRoundCardIds,
        playedCardsByPlayer,
      };

      // Check if both players' hands are empty
      const p1HandPile = state.piles["P1-hand"];
      const p2HandPile = state.piles["P2-hand"];
      const p1Remaining =
        (p1HandPile?.size || 0) - (fromPileId === "P1-hand" ? 1 : 0);
      const p2Remaining =
        (p2HandPile?.size || 0) - (fromPileId === "P2-hand" ? 1 : 0);
      const actingPlayerRemaining =
        intent.playerId === "P1" ? p1Remaining : p2Remaining;
      const otherPlayerRemaining =
        intent.playerId === "P1" ? p2Remaining : p1Remaining;
      const remainingHandCards = handPile.cards.filter((c) => c.id !== cardId);
      const actingPlayerCanContinue = remainingHandCards.some(
        (remainingCard) => newTotal + cardValue(remainingCard) <= 31
      );

      if (p1Remaining === 0 && p2Remaining === 0) {
        // All cards played
        // If total is not 31, award "last card" point
        if (newTotal !== 31) {
          newScores[intent.playerId] = (newScores[intent.playerId] || 0) + 1;
          engineEvents.push({
            type: "announce",
            text: `${intent.playerId}: Last card (1 pt)`,
          });
        }

        nextRs.scores = newScores;
        nextRs.phase = "show";

        pushCribRevealEvents(engineEvents);

        const nonDealer = getNonDealer(rs.dealer, players);
        engineEvents.push({ type: "set-rules-state", rulesState: nextRs });
        engineEvents.push({ type: "set-current-player", player: nonDealer });
        engineEvents.push({
          type: "set-actions",
          actions: deriveActions(state, nextRs, nonDealer),
        });
        engineEvents.push({
          type: "set-scoreboards",
          scoreboards: deriveScoreboards(nextRs),
        });

        // Check for win
        if (newScores[intent.playerId]! >= WINNING_SCORE) {
          engineEvents.push({ type: "set-winner", winner: intent.playerId });
        }
      } else {
        // Continue playing
        const otherPlayer = getOtherPlayer(intent.playerId, players);
        const otherPlayerAlreadySaidGo = nextCannotPlay.includes(otherPlayer);

        // If opponent already said "Go" and the acting player has no legal
        // continuation, resolve the sequence immediately without requiring an
        // extra "Go" click from a player with no playable cards.
        if (
          !isThirtyOne &&
          otherPlayerAlreadySaidGo &&
          !actingPlayerCanContinue
        ) {
          newScores[intent.playerId] = (newScores[intent.playerId] || 0) + 1;
          engineEvents.push({
            type: "announce",
            text: `${intent.playerId}: Last card (1 pt)`,
            anchor: {
              type: "pile",
              pileId: "play",
            },
          });

          const resetRs: CribbageRulesState = {
            ...nextRs,
            playTotal: 0,
            cannotPlay: [],
            lastPlayedBy: null,
            scores: newScores,
            currentRoundCards: [],
          };
          const nextPlayer =
            actingPlayerRemaining > 0
              ? intent.playerId
              : otherPlayerRemaining > 0
                ? otherPlayer
                : intent.playerId;

          engineEvents.push({ type: "set-rules-state", rulesState: resetRs });
          engineEvents.push({ type: "set-current-player", player: nextPlayer });
          engineEvents.push({
            type: "set-actions",
            actions: deriveActions(state, resetRs, nextPlayer),
          });
          engineEvents.push({
            type: "set-scoreboards",
            scoreboards: deriveScoreboards(resetRs),
          });

          if (newScores[intent.playerId]! >= WINNING_SCORE) {
            engineEvents.push({ type: "set-winner", winner: intent.playerId });
          }

          return { valid: true, engineEvents };
        }

        const nextPlayer = isThirtyOne
          ? otherPlayer
          : nextCannotPlay.includes(otherPlayer)
            ? intent.playerId
            : otherPlayer;

        engineEvents.push({ type: "set-rules-state", rulesState: nextRs });
        engineEvents.push({ type: "set-current-player", player: nextPlayer });
        engineEvents.push({
          type: "set-actions",
          actions: deriveActions(state, nextRs, nextPlayer),
        });
        engineEvents.push({
          type: "set-scoreboards",
          scoreboards: deriveScoreboards(nextRs),
        });

        // Check for win
        if (newScores[intent.playerId]! >= WINNING_SCORE) {
          engineEvents.push({ type: "set-winner", winner: intent.playerId });
        }
      }

      return { valid: true, engineEvents };
    }

    // ========================================================================
    // PHASE: show
    // ========================================================================
    if (rs.phase === "show") {
      // Accept "show" action from any player to trigger automatic scoring
      if (intent.type !== "action" || intent.action !== "show") {
        return {
          valid: false,
          reason: "Click 'Show Hands' to see scores.",
          engineEvents: [],
        };
      }

      const starterPile = state.piles["starter"];
      if (
        !starterPile ||
        !starterPile.cards ||
        starterPile.cards.length === 0
      ) {
        return {
          valid: false,
          reason: "No starter card found.",
          engineEvents: [],
        };
      }

      const starterCard = starterPile.cards[0]!;
      const newScores = { ...rs.scores };
      const nonDealer = getNonDealer(rs.dealer, players);
      const playedCardsByPlayer = normalizePlayedCardsByPlayer(rs, players);

      // Move pegged cards into show piles for visibility
      for (const player of players) {
        const cardIds = playedCardsByPlayer[player.id] ?? [];
        if (cardIds.length > 0) {
          engineEvents.push({
            type: "move-cards",
            fromPileId: "play",
            toPileId: `${player.id}-show`,
            cardIds: cardIds as [number, ...number[]],
          });
        }
      }

      // Score non-dealer's hand first
      const nonDealerCards = cardsFromIds(
        playedCardsByPlayer[nonDealer] ?? [],
        state.allCards
      );
      if (nonDealerCards.length > 0) {
        const { points, breakdown } = scoreHand(
          nonDealerCards,
          starterCard,
          false
        );
        newScores[nonDealer] = (newScores[nonDealer] || 0) + points;
        engineEvents.push({
          type: "announce",
          text: `${nonDealer} hand: ${breakdown.join(", ")} = ${points} pts`,
          anchor: {
            type: "pile",
            pileId: `${nonDealer}-show`,
          },
        });
      }

      // Check for win
      if (newScores[nonDealer]! >= WINNING_SCORE) {
        const nextRs: CribbageRulesState = {
          ...rs,
          phase: "complete",
          scores: newScores,
        };
        engineEvents.push({ type: "set-rules-state", rulesState: nextRs });
        engineEvents.push({
          type: "set-scoreboards",
          scoreboards: deriveScoreboards(nextRs),
        });
        engineEvents.push({ type: "set-winner", winner: nonDealer });
        return { valid: true, engineEvents };
      }

      // Score dealer's hand
      const dealerCards = cardsFromIds(
        playedCardsByPlayer[rs.dealer] ?? [],
        state.allCards
      );
      if (dealerCards.length > 0) {
        const { points, breakdown } = scoreHand(
          dealerCards,
          starterCard,
          false
        );
        newScores[rs.dealer] = (newScores[rs.dealer] || 0) + points;
        engineEvents.push({
          type: "announce",
          text: `${rs.dealer} hand: ${breakdown.join(", ")} = ${points} pts`,
          anchor: {
            type: "pile",
            pileId: `${rs.dealer}-show`,
          },
        });
      }

      // Check for win
      if (newScores[rs.dealer]! >= WINNING_SCORE) {
        const nextRs: CribbageRulesState = {
          ...rs,
          phase: "complete",
          scores: newScores,
        };
        engineEvents.push({ type: "set-rules-state", rulesState: nextRs });
        engineEvents.push({
          type: "set-scoreboards",
          scoreboards: deriveScoreboards(nextRs),
        });
        engineEvents.push({ type: "set-winner", winner: rs.dealer });
        return { valid: true, engineEvents };
      }

      // Score dealer's crib
      const cribPile = state.piles["crib"];
      if (cribPile?.cards) {
        const { points, breakdown } = scoreHand(
          cribPile.cards,
          starterCard,
          true
        );
        newScores[rs.dealer] = (newScores[rs.dealer] || 0) + points;
        engineEvents.push({
          type: "announce",
          text: `${rs.dealer} crib: ${breakdown.join(", ")} = ${points} pts`,
          anchor: {
            type: "pile",
            pileId: "crib",
          },
        });
      }

      // Check for win
      if (newScores[rs.dealer]! >= WINNING_SCORE) {
        const nextRs: CribbageRulesState = {
          ...rs,
          phase: "complete",
          scores: newScores,
        };
        engineEvents.push({ type: "set-rules-state", rulesState: nextRs });
        engineEvents.push({
          type: "set-scoreboards",
          scoreboards: deriveScoreboards(nextRs),
        });
        engineEvents.push({ type: "set-winner", winner: rs.dealer });
        return { valid: true, engineEvents };
      }

      const nextDealer = getOtherPlayer(rs.dealer, players);
      const nextDealNumber = rs.dealNumber + 1;

      const nextRs: CribbageRulesState = {
        ...rs,
        phase: "initial",
        hasDealt: false,
        dealNumber: nextDealNumber,
        dealer: nextDealer,
        scores: newScores,
        playCount: 0,
        playTotal: 0,
        lastPlayedBy: null,
        cannotPlay: [],
        starterSuit: null,
        currentRoundCards: [],
        playedCardsByPlayer: createEmptyPlayedCardsByPlayer(players),
      };

      engineEvents.push({ type: "set-rules-state", rulesState: nextRs });
      engineEvents.push({ type: "set-current-player", player: null });
      engineEvents.push({
        type: "set-actions",
        actions: deriveActions(state, nextRs, null),
      });
      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: deriveScoreboards(nextRs),
      });

      return { valid: true, engineEvents };
    }

    return {
      valid: false,
      reason: "Invalid action for current phase",
      engineEvents: [],
    };
  },
};

// ============================================================================
// Plugin Export
// ============================================================================

export const cribbagePlugin: GamePlugin = {
  id: "cribbage",
  gameName: "Cribbage",
  description:
    "Classic two-player card game where players score points for pairs, runs, and combinations totaling 15. First to 121 points wins.",
  ruleModule: cribbageRuleModule,
  validationHints: {
    sharedPileIds: ["deck", "crib", "starter", "play"],
    isPileAlwaysVisibleToRules: (pileId) => pileId.endsWith("-hand"),
  },
};
