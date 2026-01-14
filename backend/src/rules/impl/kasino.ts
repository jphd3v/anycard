import type { GameRuleModule, GamePlugin } from "../interface.js";
import type { ValidationState } from "../../validation-state.js";
import type { ClientIntent, Scoreboard } from "../../../../shared/schemas.js";
import type {
  ValidationResult,
  EngineEvent,
} from "../../../../shared/validation.js";
import { loadGameMeta } from "../meta.js";
import { getSuitSymbol } from "../../util/card-notation.js";
import { projectPilesAfterEvents, type ProjectedPiles } from "../util/piles.js";
import {
  gatherAllCards,
  shuffleAllCards,
  distributeRoundRobin,
} from "../util/dealing.js";

const META = loadGameMeta("kasino");

/**
 * Kasino (Finnish Casino) Rules Implementation.
 *
 * Rules based on https://www.pagat.com/fishing/nordic_casino.html#finland
 * - 2 players.
 * - Aces: 1 on table, 14 from hand.
 * - 2 of Spades (Small Kasino): 2 on table, 15 from hand.
 * - 10 of Diamonds (Big Kasino): 10 on table, 16 from hand.
 * - Captures are NOT mandatory.
 * - Immediate points for Aces (1), 2 of Spades (1), 10 of Diamonds (2).
 * - End of hand points: Most cards (1), Most spades (2).
 * - Mökki (Sweep): 1 point, cancelled if both players get one.
 * - No points for Mökki if a player has 10+ points or it's the last deal.
 * - Game ends at 16 points.
 */

interface KasinoRulesState {
  hasDealt?: boolean;
  dealNumber: number;
  phase: "dealing" | "playing" | "ended";
  roundNumber: number;
  players: string[];
  lastCapturer: string | null;
  sweeps: Record<string, number>;
  scores: Record<string, number>;
  handPoints: Record<string, number>;
  isLastDeal: boolean;
  result: string | null;
}

const RANK_VALUE: Record<string, number> = {
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
  J: 11,
  Q: 12,
  K: 13,
};

function getCardTableValue(rank: string): number {
  return RANK_VALUE[rank] || 0;
}

function getCardHandValue(rank: string, suit: string): number {
  if (rank === "A") return 14;
  if (rank === "2" && suit === "spades") return 15;
  if (rank === "10" && suit === "diamonds") return 16;
  return RANK_VALUE[rank] || 0;
}

function getOtherPlayer(current: string, players: string[]): string {
  const idx = players.indexOf(current);
  if (idx === -1) return players[0];
  return players[(idx + 1) % players.length];
}

function generateGroupsToTarget(
  cards: { id: number; value: number }[],
  target: number
): number[][] {
  const results: number[][] = [];
  const seen = new Set<string>();

  function backtrack(start: number, sum: number, subset: number[]) {
    if (sum === target) {
      const key = subset
        .slice()
        .sort((a, b) => a - b)
        .join("-");
      if (!seen.has(key)) {
        results.push([...subset]);
        seen.add(key);
      }
      return;
    }
    if (sum > target) return;

    for (let i = start; i < cards.length; i++) {
      const card = cards[i];
      if (sum + card.value > target) continue;
      subset.push(card.id);
      backtrack(i + 1, sum + card.value, subset);
      subset.pop();
    }
  }

  backtrack(0, 0, []);
  return results;
}

function calculateCaptures(
  playedCard: { rank: string; suit: string },
  tableCards: { id: number; rank: string; suit: string }[]
): number[] {
  const target = getCardHandValue(playedCard.rank, playedCard.suit);
  const cards = tableCards.map((c) => ({
    id: c.id,
    value: getCardTableValue(c.rank),
  }));
  const cardLookup = new Map<number, { rank: string; suit: string }>();
  tableCards.forEach((c) =>
    cardLookup.set(c.id, { rank: c.rank, suit: c.suit })
  );

  let best: number[] = [];

  const captureWeight = (ids: number[]) => {
    return ids.reduce((acc, id) => {
      const info = cardLookup.get(id);
      if (!info) return acc;
      if (info.rank === "A") acc += 3;
      if (info.rank === "10" && info.suit === "diamonds") acc += 2;
      if (info.rank === "2" && info.suit === "spades") acc += 2;
      if (info.suit === "spades") acc += 1;
      return acc;
    }, 0);
  };

  function search(available: typeof cards, captured: number[]) {
    if (
      captured.length > best.length ||
      (captured.length === best.length &&
        captureWeight(captured) > captureWeight(best))
    ) {
      best = [...captured];
    }

    if (captured.length + available.length <= best.length) return;

    const groups = generateGroupsToTarget(available, target);
    for (const group of groups) {
      const groupSet = new Set(group);
      const remaining = available.filter((c) => !groupSet.has(c.id));
      search(remaining, [...captured, ...group]);
    }
  }

  search(cards, []);
  return Array.from(new Set(best));
}

function dealCards(
  state: ValidationState,
  rulesState: KasinoRulesState
): EngineEvent[] {
  const deck = state.piles["deck"];
  if (!deck || !deck.cards) throw new Error("No deck");

  const players = rulesState.players;
  const events: EngineEvent[] = [];

  if (deck.size === 0) return [];

  const cardIds = deck.cards.map((c) => c.id);
  let cardIdx = 0;

  // Deal to players (4 each)
  for (let i = 0; i < 4; i++) {
    for (const pid of players) {
      if (cardIdx < cardIds.length) {
        events.push({
          type: "move-cards",
          fromPileId: "deck",
          toPileId: `${pid}-hand`,
          cardIds: [cardIds[cardIdx]],
        });
        cardIdx++;
      }
    }
  }

  // Deal to table (only if first deal of the hand)
  if (rulesState.roundNumber === 1) {
    for (let i = 0; i < 4; i++) {
      if (cardIdx < cardIds.length) {
        events.push({
          type: "move-cards",
          fromPileId: "deck",
          toPileId: "table",
          cardIds: [cardIds[cardIdx]],
        });
        cardIdx++;
      }
    }
  }

  // Check if this is the last deal of the deck
  if (cardIdx >= cardIds.length) {
    rulesState.isLastDeal = true;
  }

  return events;
}

function buildScoreboard(
  projectedPiles: ProjectedPiles,
  rulesState: KasinoRulesState
): Scoreboard {
  const { totalPoints, handStats } = calculateFullStats(
    projectedPiles,
    rulesState
  );
  const players = rulesState.players;
  const cells: Scoreboard["cells"] = [
    { row: 0, col: 0, text: "Player", role: "header" },
    { row: 0, col: 1, text: "Cards", role: "header", align: "right" },
    {
      row: 0,
      col: 2,
      text: getSuitSymbol("spades"),
      role: "header",
      align: "right",
    },
    { row: 0, col: 3, text: "Mökki", role: "header", align: "right" },
    { row: 0, col: 4, text: "Deal Pts", role: "header", align: "right" },
    { row: 0, col: 5, text: "TOTAL", role: "header", align: "right" },
  ];

  players.forEach((pid, idx) => {
    const stats = handStats[pid];
    cells.push(
      { row: idx + 1, col: 0, text: pid },
      { row: idx + 1, col: 1, text: String(stats.cards), align: "right" },
      { row: idx + 1, col: 2, text: String(stats.spades), align: "right" },
      {
        row: idx + 1,
        col: 3,
        text: String(rulesState.sweeps[pid] || 0),
        align: "right",
      },
      { row: idx + 1, col: 4, text: String(stats.points), align: "right" },
      {
        row: idx + 1,
        col: 5,
        text: String(totalPoints[pid]),
        align: "right",
        role: "total",
      }
    );
  });

  return {
    id: "kasino-score",
    title: "Kasino Score",
    rows: players.length + 1,
    cols: 6,
    cells,
  };
}

function calculateFullStats(
  projectedPiles: ProjectedPiles,
  rulesState: KasinoRulesState
) {
  const players = rulesState.players;

  // 1. Calculate Hand Stats (what happened in this deal)
  const handStats: Record<
    string,
    {
      cards: number;
      spades: number;
      points: number; // Combined points for this hand
    }
  > = {};

  let maxCards = 0;
  let maxSpades = 0;

  players.forEach((pid) => {
    const wonPile = projectedPiles[`${pid}-won`];
    const wonCards = wonPile?.cards || [];
    const cards = wonCards.length;
    const spades = wonCards.filter((c) => c.suit === "spades").length;

    handStats[pid] = { cards, spades, points: rulesState.handPoints[pid] || 0 };
    maxCards = Math.max(maxCards, cards);
    maxSpades = Math.max(maxSpades, spades);
  });

  // 2. Add end-of-hand bonuses (Majority cards/spades and sweeps)
  const isHandEnded = rulesState.phase === "ended";
  const totalPoints: Record<string, number> = {};

  // Mökki (Sweep) cancellation logic
  const allPlayersSwept = players.every((p) => (rulesState.sweeps[p] || 0) > 0);

  players.forEach((pid) => {
    let handBonus = 0;
    if (isHandEnded) {
      // Majority Cards (1pt)
      const playersWithMaxCards = players.filter(
        (p) => handStats[p].cards === maxCards
      );
      if (playersWithMaxCards.length === 1 && playersWithMaxCards[0] === pid)
        handBonus += 1;

      // Majority Spades (2pts)
      const playersWithMaxSpades = players.filter(
        (p) => handStats[p].spades === maxSpades
      );
      if (playersWithMaxSpades.length === 1 && playersWithMaxSpades[0] === pid)
        handBonus += 2;

      // Sweeps
      if (!allPlayersSwept) {
        handBonus += rulesState.sweeps[pid] || 0;
      }
    }

    handStats[pid].points += handBonus;
    totalPoints[pid] = (rulesState.scores[pid] || 0) + handStats[pid].points;
  });

  return { totalPoints, handStats };
}

function checkVictory(totalPoints: Record<string, number>): string | null {
  // Game ends when a player reaches 16 points.
  const TARGET = 16;
  let winner: string | null = null;
  let maxScore = -1;

  for (const [pid, score] of Object.entries(totalPoints)) {
    if (score >= TARGET) {
      if (score > maxScore) {
        maxScore = score;
        winner = pid;
      } else if (score === maxScore) {
        winner = "Tie"; // Will handle tie later
      }
    }
  }
  return winner;
}

export const kasinoRules: GameRuleModule = {
  listLegalIntentsForPlayer(
    state: ValidationState,
    playerId: string
  ): ClientIntent[] {
    const intents: ClientIntent[] = [];
    const rawRulesState = (state.rulesState as Partial<KasinoRulesState>) ?? {};
    const rulesState: KasinoRulesState = {
      hasDealt: rawRulesState.hasDealt ?? false,
      dealNumber: rawRulesState.dealNumber ?? 0,
      phase: rawRulesState.phase ?? "dealing",
      roundNumber: rawRulesState.roundNumber ?? 1,
      players: rawRulesState.players ?? ["P1", "P2"],
      lastCapturer: rawRulesState.lastCapturer ?? null,
      sweeps: rawRulesState.sweeps ?? {},
      scores: rawRulesState.scores ?? {},
      handPoints: rawRulesState.handPoints ?? {},
      isLastDeal: rawRulesState.isLastDeal ?? false,
      result: rawRulesState.result ?? null,
    };

    const gameId = state.gameId;

    if (!rulesState.hasDealt) {
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

    if (rulesState.phase === "ended") return intents;

    const playerHandPileId = `${playerId}-hand`;
    const playerHand = state.piles[playerHandPileId];

    if (
      !playerHand ||
      !state.currentPlayer ||
      state.currentPlayer !== playerId
    ) {
      return intents;
    }

    const candidates: ClientIntent[] = [];
    for (const card of playerHand.cards ?? []) {
      candidates.push({
        type: "move",
        gameId,
        playerId,
        fromPileId: playerHandPileId,
        toPileId: `${playerId}-won`,
        cardId: card.id,
      });
      candidates.push({
        type: "move",
        gameId,
        playerId,
        fromPileId: playerHandPileId,
        toPileId: "table",
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

  validate(state: ValidationState, intent: ClientIntent): ValidationResult {
    const engineEvents: EngineEvent[] = [];
    const rawRulesState = (state.rulesState as Partial<KasinoRulesState>) ?? {};

    const rulesState: KasinoRulesState = {
      hasDealt: rawRulesState.hasDealt ?? false,
      dealNumber: rawRulesState.dealNumber ?? 0,
      phase: rawRulesState.phase ?? "dealing",
      roundNumber: rawRulesState.roundNumber ?? 1,
      players: rawRulesState.players ?? ["P1", "P2"],
      lastCapturer: rawRulesState.lastCapturer ?? null,
      sweeps: rawRulesState.sweeps ?? {},
      scores: rawRulesState.scores ?? {},
      handPoints: rawRulesState.handPoints ?? {},
      isLastDeal: rawRulesState.isLastDeal ?? false,
      result: rawRulesState.result ?? null,
    };

    if (intent.type === "action" && intent.action === "start-game") {
      if (rulesState.phase !== "dealing" && rulesState.phase !== "ended") {
        return {
          valid: false,
          reason: "The game has already started.",
          engineEvents: [],
        };
      }

      const previousPhase = rulesState.phase;
      rulesState.phase = "playing";
      rulesState.hasDealt = true;

      const isContinuation =
        previousPhase === "dealing" && rulesState.dealNumber > 0;

      if (isContinuation) {
        rulesState.roundNumber = 1;
        rulesState.isLastDeal = false;
        rulesState.lastCapturer = null;
        rulesState.sweeps = {};
        rulesState.handPoints = {};
      } else {
        // Fresh game
        rulesState.dealNumber = 1;
        rulesState.roundNumber = 1;
        rulesState.isLastDeal = false;
        rulesState.players.forEach((p) => {
          rulesState.scores[p] = 0;
          rulesState.sweeps[p] = 0;
          rulesState.handPoints[p] = 0;
        });
      }

      // Gather all cards back to deck explicitly (avoid using 'any')
      engineEvents.push(...gatherAllCards(state));

      // Reset all hand visibilities to owner-only for the next deal
      for (const player of rulesState.players) {
        engineEvents.push({
          type: "set-pile-visibility",
          pileId: `${player}-hand`,
          visibility: "owner",
        });
      }

      // SHUFFLE the deck cards deterministically before starting
      const shuffledCardIds = shuffleAllCards(
        state,
        rulesState.dealNumber,
        "KASINO"
      );

      engineEvents.push({ type: "set-rules-state", rulesState });

      // Now deal from the shuffled deck directly
      const players = rulesState.players;
      const { events: dealEvents, nextIndex } = distributeRoundRobin(
        shuffledCardIds,
        players.map((p) => `${p}-hand`),
        4
      );
      engineEvents.push(...dealEvents);

      const tableCards = shuffledCardIds.slice(nextIndex, nextIndex + 4);
      engineEvents.push({
        type: "move-cards",
        fromPileId: "deck",
        toPileId: "table",
        cardIds: tableCards as [number, ...number[]],
      });

      engineEvents.push({
        type: "set-current-player",
        player: rulesState.players[0],
      });

      const sb = buildScoreboard(
        projectPilesAfterEvents(state, engineEvents),
        rulesState
      );
      engineEvents.push({ type: "set-scoreboards", scoreboards: [sb] });

      return { valid: true, engineEvents };
    }

    if (intent.type === "move") {
      const { playerId, fromPileId, toPileId, cardId } = intent;

      if (state.currentPlayer !== playerId)
        return {
          valid: false,
          reason: "It is not your turn.",
          engineEvents: [],
        };
      if (cardId === undefined)
        return {
          valid: false,
          reason: "Move requires cardId.",
          engineEvents: [],
        };
      if (fromPileId !== `${playerId}-hand`)
        return {
          valid: false,
          reason: "You must play cards from your own hand.",
          engineEvents: [],
        };

      const isTrail = toPileId === "table";
      const isCaptureAttempt = toPileId === `${playerId}-won`;
      if (!isTrail && !isCaptureAttempt) {
        return {
          valid: false,
          reason:
            "In Kasino, you must play cards to the table or your won pile.",
          engineEvents: [],
        };
      }

      const handPile = state.piles[fromPileId];
      // Engine guarantees card exists in source pile
      const playedCard = handPile.cards!.find((c) => c.id === cardId)!;

      const tablePile = state.piles["table"];
      const tableCards = tablePile?.cards ?? [];

      const capturedIds = calculateCaptures(
        { rank: playedCard.rank, suit: playedCard.suit },
        tableCards.map((c) => ({ id: c.id, rank: c.rank, suit: c.suit }))
      );

      if (isCaptureAttempt) {
        if (capturedIds.length === 0) {
          return {
            valid: false,
            reason: "No capture available with that card.",
            engineEvents: [],
          };
        }
        const wonPileId = `${playerId}-won`;
        engineEvents.push({
          type: "move-cards",
          fromPileId: fromPileId,
          toPileId: wonPileId,
          cardIds: [cardId],
        });
        engineEvents.push({
          type: "move-cards",
          fromPileId: "table",
          toPileId: wonPileId,
          cardIds: capturedIds as [number, ...number[]],
        });

        rulesState.lastCapturer = playerId;

        const allMoving = [
          playedCard,
          ...tableCards.filter((c) => capturedIds.includes(c.id)),
        ];
        allMoving.forEach((c) => {
          if (c.rank === "A")
            rulesState.handPoints[playerId] =
              (rulesState.handPoints[playerId] || 0) + 1;
          if (c.rank === "10" && c.suit === "diamonds")
            rulesState.handPoints[playerId] =
              (rulesState.handPoints[playerId] || 0) + 2;
          if (c.rank === "2" && c.suit === "spades")
            rulesState.handPoints[playerId] =
              (rulesState.handPoints[playerId] || 0) + 1;
        });

        if (
          tableCards.length === capturedIds.length &&
          !rulesState.isLastDeal &&
          (rulesState.scores[playerId] || 0) < 10
        ) {
          rulesState.sweeps[playerId] = (rulesState.sweeps[playerId] || 0) + 1;
          engineEvents.push({
            type: "announce",
            text: `Sweep by ${playerId}!`,
            anchor: { type: "pile", pileId: "table" },
          });
        }
      } else {
        engineEvents.push({
          type: "move-cards",
          fromPileId: fromPileId,
          toPileId: "table",
          cardIds: [cardId],
        });
      }

      const nextPlayer = getOtherPlayer(playerId, rulesState.players);
      const currentPlayerHandSize = (handPile?.size ?? 0) - 1;
      const otherPlayersEmpty = rulesState.players
        .filter((p) => p !== playerId)
        .every((p) => (state.piles[`${p}-hand`]?.size ?? 0) === 0);

      if (currentPlayerHandSize === 0 && otherPlayersEmpty) {
        const deck = state.piles["deck"];
        if (deck && deck.size > 0) {
          rulesState.roundNumber += 1;
          engineEvents.push(...dealCards(state, rulesState));
          engineEvents.push({ type: "set-current-player", player: nextPlayer });
        } else {
          rulesState.phase = "ended";
          const remainingTableIds = tableCards
            .map((c) => c.id)
            .filter((id) => !capturedIds.includes(id));
          if (isTrail) remainingTableIds.push(cardId);

          if (rulesState.lastCapturer && remainingTableIds.length > 0) {
            engineEvents.push({
              type: "move-cards",
              fromPileId: "table",
              toPileId: `${rulesState.lastCapturer}-won`,
              cardIds: remainingTableIds as [number, ...number[]],
            });
            const cardLookup = new Map<
              number,
              { rank: string; suit: string }
            >();
            tableCards.forEach((c) =>
              cardLookup.set(c.id, { rank: c.rank, suit: c.suit })
            );
            if (isTrail)
              cardLookup.set(cardId, {
                rank: playedCard.rank,
                suit: playedCard.suit,
              });

            remainingTableIds.forEach((id) => {
              const c = cardLookup.get(id);
              if (!c) return;
              if (c.rank === "A")
                rulesState.handPoints[rulesState.lastCapturer!] =
                  (rulesState.handPoints[rulesState.lastCapturer!] || 0) + 1;
              if (c.rank === "10" && c.suit === "diamonds")
                rulesState.handPoints[rulesState.lastCapturer!] =
                  (rulesState.handPoints[rulesState.lastCapturer!] || 0) + 2;
              if (c.rank === "2" && c.suit === "spades")
                rulesState.handPoints[rulesState.lastCapturer!] =
                  (rulesState.handPoints[rulesState.lastCapturer!] || 0) + 1;
            });
          }
          engineEvents.push({ type: "set-current-player", player: null });
        }
      } else {
        engineEvents.push({ type: "set-current-player", player: nextPlayer });
      }

      const projected = projectPilesAfterEvents(state, engineEvents);
      const { totalPoints } = calculateFullStats(projected, rulesState);
      const winner = checkVictory(totalPoints);

      if (winner) {
        rulesState.phase = "ended";
        engineEvents.push({ type: "set-winner", winner });
        engineEvents.push({ type: "set-current-player", player: null });
      } else if (rulesState.phase === "ended") {
        const scoreLine = rulesState.players
          .map((p) => {
            const { handStats } = calculateFullStats(projected, rulesState);
            const handPts = handStats[p].points;
            rulesState.scores[p] += handPts;
            return `${p}: ${handPts} pts (Total: ${rulesState.scores[p]})`;
          })
          .join(", ");
        rulesState.result = `Hand ${rulesState.dealNumber} Result: ${scoreLine}.`;

        const finalWinner = checkVictory(rulesState.scores);
        if (finalWinner) {
          engineEvents.push({ type: "set-winner", winner: finalWinner });
        } else {
          rulesState.hasDealt = false;
          rulesState.dealNumber += 1;
          rulesState.phase = "dealing";
        }
      }

      engineEvents.push({ type: "set-rules-state", rulesState });
      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: [buildScoreboard(projected, rulesState)],
      });

      return { valid: true, engineEvents };
    }

    return { valid: false, reason: "Unknown intent", engineEvents: [] };
  },
};

export const kasinoPlugin: GamePlugin = {
  id: "kasino",
  gameName: META.gameName,
  ruleModule: kasinoRules,
  description: META.description,
  validationHints: {
    sharedPileIds: ["table", "deck"],
  },
};
