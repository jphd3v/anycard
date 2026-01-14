// backend/src/rules/impl/scopa.ts

/**
 * Canonical Scopa rules (deterministic TypeScript implementation).
 *
 * 2-player Italian fishing game with:
 * - 40-card deck (A,2,3,4,5,6,7,J,Q,K in each suit)
 * - Capture by same rank or by sum of values
 * - Scopas when you clear the table
 * - Scoring: cards, coins (diamonds), settebello, primiera, scopas
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
import { createRandom, fisherYates, stringToSeed } from "../../util/random.js";
import { projectPilesAfterEvents, type ProjectedPiles } from "../util/piles.js";
import { gatherAllCards, distributeRoundRobin } from "../util/dealing.js";

const META = loadGameMeta("scopa");

type ScopaPhase = "dealing" | "playing" | "ended";

interface ScopaRulesState {
  hasDealt: boolean;
  dealNumber: number; // NEW: tracks full deck deals
  phase: ScopaPhase;
  roundNumber: number;
  players: string[];
  lastCapturer: string | null;
  scopas: Record<string, number>;
  result: string | null;
}

type SimpleCard = { id: number; rank: string; suit: string };

// --- Helpers ---

const CARD_VALUE: Record<string, number> = {
  A: 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  J: 8,
  Q: 9,
  K: 10,
};

const PRIMIERA_VALUE: Record<string, number> = {
  "7": 21,
  "6": 18,
  A: 16,
  "5": 15,
  "4": 14,
  "3": 13,
  "2": 12,
  J: 10,
  Q: 10,
  K: 10,
};

const SUITS: Array<"clubs" | "diamonds" | "hearts" | "spades"> = [
  "clubs",
  "diamonds",
  "hearts",
  "spades",
];

function getScopaRulesState(raw: unknown, players: string[]): ScopaRulesState {
  const base: ScopaRulesState = {
    hasDealt: false,
    dealNumber: 0,
    phase: "dealing",
    roundNumber: 1,
    players,
    lastCapturer: null,
    scopas: Object.fromEntries(players.map((p) => [p, 0])),
    result: null,
  };

  if (!raw || typeof raw !== "object") return base;

  const obj = raw as Partial<ScopaRulesState>;
  const merged: ScopaRulesState = {
    hasDealt: obj.hasDealt ?? base.hasDealt,
    dealNumber: obj.dealNumber ?? base.dealNumber,
    phase: obj.phase ?? base.phase,
    roundNumber: obj.roundNumber ?? base.roundNumber,
    players:
      Array.isArray(obj.players) && obj.players.length > 0
        ? obj.players
        : base.players,
    lastCapturer: obj.lastCapturer ?? base.lastCapturer,
    scopas: { ...base.scopas, ...(obj.scopas ?? {}) },
    result: obj.result ?? base.result,
  };

  for (const p of merged.players) {
    if (typeof merged.scopas[p] !== "number") {
      merged.scopas[p] = 0;
    }
  }

  return merged;
}

function getOtherPlayer(current: string, players: string[]): string {
  const other = players.find((p) => p !== current);
  return other ?? current;
}

function cardValue(rank: string): number {
  return CARD_VALUE[rank] ?? 0;
}

function primieraValue(rank: string): number {
  return PRIMIERA_VALUE[rank] ?? 0;
}

function computePrimiera(cards: SimpleCard[]): number {
  const bestBySuit: Record<string, number> = {
    clubs: 0,
    diamonds: 0,
    hearts: 0,
    spades: 0,
  };

  for (const c of cards) {
    const v = primieraValue(c.rank);
    if (v > bestBySuit[c.suit]) {
      bestBySuit[c.suit] = v;
    }
  }

  return SUITS.reduce((sum, s) => sum + (bestBySuit[s] ?? 0), 0);
}

function dealCards(
  state: ValidationState,
  rulesState: ScopaRulesState
): EngineEvent[] {
  const deck = state.piles["deck"];
  if (!deck || !deck.cards) {
    throw new Error("[scopa] No deck pile or deck.cards missing");
  }

  const players = rulesState.players;
  let cardIds = deck.cards.map((c) => c.id);
  const deckSize = cardIds.length;
  const events: EngineEvent[] = [];

  if (deckSize === 40) {
    let tableValid = false;
    let seedIndex = state.moveIndex;

    // We don't have a shuffleAllCards version that takes a manual set of IDs,
    // and Scopa has this "max 3 kings on table" rule.
    // Let's implement it with a local loop for now, but still using our random utils.
    while (!tableValid) {
      const allCardIds = Object.keys(state.allCards)
        .map(Number)
        .sort((a, b) => a - b);
      const baseSeed = stringToSeed(state.seed || "SCOPA");
      const random = createRandom(baseSeed + rulesState.dealNumber + seedIndex);
      cardIds = fisherYates(allCardIds, random);

      const tableCardsCandidate = cardIds
        .slice(6, 10)
        .map((id) => state.allCards[id]);
      const kingCount = tableCardsCandidate.filter(
        (c) => c.rank === "K"
      ).length;

      if (kingCount < 3) {
        tableValid = true;
      } else {
        seedIndex++;
      }
    }

    const { events: dealEvents, nextIndex } = distributeRoundRobin(
      cardIds,
      players.map((p) => `${p}-hand`),
      3
    );
    events.push(...dealEvents);

    const tableCards = cardIds.slice(nextIndex, nextIndex + 4);
    events.push({
      type: "move-cards",
      fromPileId: "deck",
      toPileId: "table",
      cardIds: tableCards as [number, ...number[]],
    });
  } else {
    const { events: dealEvents } = distributeRoundRobin(
      cardIds,
      players.map((p) => `${p}-hand`),
      3
    );
    events.push(...dealEvents);
  }

  return events;
}

type CaptureResult = {
  capturedTableCardIds: number[];
  isCapture: boolean;
  isScopa: boolean;
};

function computeCapture(
  playedCard: SimpleCard,
  tableCards: SimpleCard[]
): CaptureResult {
  const tableIds = tableCards.map((c) => c.id);
  const playedVal = cardValue(playedCard.rank);
  const equalValueCards = tableCards.filter(
    (c) => cardValue(c.rank) === playedVal
  );
  if (equalValueCards.length > 0) {
    const chosen = equalValueCards[0];
    const capturedTableCardIds = [chosen.id];
    const remainingCount = tableIds.length - capturedTableCardIds.length;
    return {
      capturedTableCardIds,
      isCapture: true,
      isScopa: remainingCount === 0,
    };
  }

  const target = cardValue(playedCard.rank);
  if (target <= 0) {
    return { capturedTableCardIds: [], isCapture: false, isScopa: false };
  }

  let best: SimpleCard[] = [];

  function search(idx: number, chosen: SimpleCard[], sum: number) {
    if (sum > target) return;
    if (sum === target) {
      if (
        chosen.length > best.length ||
        (chosen.length === best.length &&
          chosen.reduce((a, c) => a + cardValue(c.rank), 0) >
            best.reduce((a, c) => a + cardValue(c.rank), 0))
      ) {
        best = [...chosen];
      }
      return;
    }
    if (idx >= tableCards.length) return;
    if (chosen.length + (tableCards.length - idx) <= best.length) return;
    search(idx + 1, chosen, sum);
    const c = tableCards[idx];
    search(idx + 1, [...chosen, c], sum + cardValue(c.rank));
  }

  search(0, [], 0);

  if (best.length === 0) {
    return { capturedTableCardIds: [], isCapture: false, isScopa: false };
  }

  const capturedTableCardIds = best.map((c) => c.id);
  const remainingCount = tableIds.length - capturedTableCardIds.length;

  return {
    capturedTableCardIds,
    isCapture: true,
    isScopa: remainingCount === 0,
  };
}

type PerPlayerScore = {
  cards: number;
  coins: number;
  hasSettebello: boolean;
  primiera: number;
  scopas: number;
  basePoints: number;
  totalPoints: number;
};

function computeScores(
  projected: ProjectedPiles,
  rulesState: ScopaRulesState
): Record<string, PerPlayerScore> {
  const result: Record<string, PerPlayerScore> = {};
  const players = rulesState.players;

  for (const pid of players) {
    const won = projected[`${pid}-won`];
    const cards = won?.cards ?? [];

    const totalCards = cards.length;
    const coins = cards.filter((c) => c.suit === "diamonds").length;
    const hasSettebello = cards.some(
      (c) => c.suit === "diamonds" && c.rank === "7"
    );
    const prim = computePrimiera(cards);
    const scopas = rulesState.scopas[pid] ?? 0;

    result[pid] = {
      cards: totalCards,
      coins,
      hasSettebello,
      primiera: prim,
      scopas,
      basePoints: 0,
      totalPoints: 0,
    };
  }

  const cardCounts = players.map((p) => result[p].cards);
  const maxCards = Math.max(...cardCounts);
  if (maxCards > 0) {
    const winners = players.filter((p) => result[p].cards === maxCards);
    if (winners.length === 1) {
      result[winners[0]].basePoints += 1;
    }
  }

  const coinsCounts = players.map((p) => result[p].coins);
  const maxCoins = Math.max(...coinsCounts);
  if (maxCoins > 0) {
    const winners = players.filter((p) => result[p].coins === maxCoins);
    if (winners.length === 1) {
      result[winners[0]].basePoints += 1;
    }
  }

  const setteWinners = players.filter((p) => result[p].hasSettebello);
  if (setteWinners.length === 1) {
    result[setteWinners[0]].basePoints += 1;
  }

  const primValues = players.map((p) => result[p].primiera);
  const maxPrim = Math.max(...primValues);
  if (maxPrim > 0) {
    const winners = players.filter((p) => result[p].primiera === maxPrim);
    if (winners.length === 1) {
      result[winners[0]].basePoints += 1;
    }
  }

  for (const p of players) {
    result[p].totalPoints = result[p].basePoints + result[p].scopas;
  }

  return result;
}

function buildScoreboard(
  projected: ProjectedPiles,
  rulesState: ScopaRulesState
): Scoreboard {
  const players = rulesState.players;
  const scores = computeScores(projected, rulesState);

  const rows = 7;
  const cols = players.length + 1;
  const cells: Scoreboard["cells"] = [];

  cells.push({ row: 0, col: 0, text: "Category", role: "header" });
  players.forEach((pid, idx) => {
    cells.push({
      row: 0,
      col: idx + 1,
      text: pid,
      role: "header",
      align: "center",
    });
  });

  const categories = [
    "Cards",
    `Coins (${getSuitSymbol("diamonds")})`,
    `Settebello (7${getSuitSymbol("diamonds")})`,
    "Primiera",
    "Scopas",
    "Total",
  ];

  categories.forEach((label, rowIndex) => {
    const row = rowIndex + 1;
    const role = label === "Total" ? "total" : "body";

    cells.push({ row, col: 0, text: label, role });

    players.forEach((pid, idx) => {
      const s = scores[pid];
      let value: string;

      if (label === "Cards") {
        value = String(s.cards);
      } else if (label === `Coins (${getSuitSymbol("diamonds")})`) {
        value = String(s.coins);
      } else if (label === `Settebello (7${getSuitSymbol("diamonds")})`) {
        value = s.hasSettebello ? "✓" : "";
      } else if (label === "Primiera") {
        value = String(s.primiera);
      } else if (label === "Scopas") {
        value = String(s.scopas);
      } else {
        value = String(s.totalPoints);
      }

      cells.push({
        row,
        col: idx + 1,
        text: value,
        align: "center",
        role,
      });
    });
  });

  return {
    id: "scopa-main",
    title: "Scopa score",
    rows,
    cols,
    cells,
  };
}

function determineWinner(
  projected: ProjectedPiles,
  rulesState: ScopaRulesState
): string | null {
  const scores = computeScores(projected, rulesState);
  const players = rulesState.players;

  if (players.length !== 2) return null;

  const [p1, p2] = players;
  const s1 = scores[p1].totalPoints;
  const s2 = scores[p2].totalPoints;

  if (s1 > s2) return p1;
  if (s2 > s1) return p2;
  return null;
}

const scopaRules: GameRuleModule = {
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

    const rulesState = getScopaRulesState(state.rulesState, players);
    const gameId = state.gameId;

    if (!rulesState.hasDealt) {
      intents.push({
        type: "action",
        gameId,
        playerId,
        action: "start-game",
      });
      return intents;
    }

    if (rulesState.phase === "ended") {
      return intents;
    }

    if (!state.currentPlayer || state.currentPlayer !== playerId) {
      return intents;
    }

    const playerHandPileId = `${playerId}-hand`;
    const playerHand = state.piles[playerHandPileId];
    const tablePile = state.piles["table"];

    if (!playerHand || !tablePile) {
      return intents;
    }

    for (const card of playerHand.cards ?? []) {
      const candidates: ClientIntent[] = [
        {
          type: "move",
          gameId,
          playerId,
          fromPileId: playerHandPileId,
          toPileId: `${playerId}-won`,
          cardId: card.id,
        },
        {
          type: "move",
          gameId,
          playerId,
          fromPileId: playerHandPileId,
          toPileId: "table",
          cardId: card.id,
        },
      ];

      for (const c of candidates) {
        if (this.validate(state, c).valid) {
          intents.push(c);
        }
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

    const rulesState = getScopaRulesState(state.rulesState, players);
    const engineEvents: EngineEvent[] = [];
    let nextRulesState: ScopaRulesState = { ...rulesState };

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
      engineEvents.push(...gatherAllCards(state));

      // Reset all hand visibilities to owner-only for the next deal
      for (const player of rulesState.players) {
        engineEvents.push({
          type: "set-pile-visibility",
          pileId: `${player}-hand`,
          visibility: "owner",
        });
      }

      nextRulesState = {
        ...rulesState,
        hasDealt: true,
        dealNumber: nextDealNumber,
        phase: "playing",
      };

      engineEvents.push({
        type: "set-rules-state",
        rulesState: nextRulesState,
      });

      engineEvents.push(...dealCards(state, nextRulesState));

      const firstPlayer = rulesState.players[0] ?? null;
      engineEvents.push({
        type: "set-current-player",
        player: firstPlayer,
      });

      const projected = projectPilesAfterEvents(state, engineEvents);
      const scoreboard = buildScoreboard(projected, nextRulesState);

      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: [scoreboard],
      });

      return { valid: true, engineEvents };
    }

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
        reason: "Scopa only supports playing cards as move intents.",
        engineEvents: [],
      };
    }

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

    const isTrail = intent.toPileId === "table";
    const isCaptureAttempt = intent.toPileId === `${playerId}-won`;

    if (
      intent.fromPileId !== `${playerId}-hand` ||
      (!isTrail && !isCaptureAttempt)
    ) {
      return {
        valid: false,
        reason:
          "In Scopa, you must play from your hand to the table (trail) or your won pile (capture).",
        engineEvents: [],
      };
    }

    const handPile = state.piles[`${playerId}-hand`];
    const tablePile = state.piles["table"];

    if (!handPile || !handPile.cards || !tablePile || !tablePile.cards) {
      return {
        valid: false,
        reason: "Pile not available.",
        engineEvents: [],
      };
    }

    // Engine guarantees card exists in source pile
    const played = handPile.cards.find((c) => c.id === intent.cardId)!;

    const tableCards = tablePile.cards;
    const capture = computeCapture(played, tableCards);
    const capturedTableIds = capture.capturedTableCardIds;
    const isCapture = capture.isCapture;

    if (isCapture && isTrail) {
      return {
        valid: false,
        reason: "Capture is mandatory if possible. Play to your won pile.",
        engineEvents: [],
      };
    }
    if (!isCapture && isCaptureAttempt) {
      return {
        valid: false,
        reason:
          "No capture possible with this card. Trail to the table instead.",
        engineEvents: [],
      };
    }

    if (isCapture) {
      engineEvents.push({
        type: "move-cards",
        fromPileId: `${playerId}-hand`,
        toPileId: `${playerId}-won`,
        cardIds: [intent.cardId!],
      });

      engineEvents.push({
        type: "move-cards",
        fromPileId: "table",
        toPileId: `${playerId}-won`,
        cardIds: capturedTableIds as [number, ...number[]],
      });

      nextRulesState = {
        ...nextRulesState,
        lastCapturer: playerId,
      };

      const projectedAfterCapture = projectPilesAfterEvents(
        state,
        engineEvents
      );
      const projectedTable = projectedAfterCapture["table"];
      if (projectedTable && projectedTable.size === 0) {
        const deckSize = state.piles["deck"]?.size ?? 0;
        const otherPlayer = getOtherPlayer(playerId, players);
        const myHandSizeBefore = state.piles[`${playerId}-hand`]?.size ?? 0;
        const otherHandSize = state.piles[`${otherPlayer}-hand`]?.size ?? 0;

        const isLastTrick =
          deckSize === 0 && myHandSizeBefore - 1 === 0 && otherHandSize === 0;

        if (!isLastTrick) {
          const prev = nextRulesState.scopas[playerId] ?? 0;

          engineEvents.push({
            type: "announce",
            text: `Scopa by ${playerId}!`,
            anchor: { type: "pile", pileId: "table" },
          });

          nextRulesState = {
            ...nextRulesState,
            scopas: {
              ...nextRulesState.scopas,
              [playerId]: prev + 1,
            },
          };
        }
      }
    } else {
      engineEvents.push({
        type: "move-cards",
        fromPileId: `${playerId}-hand`,
        toPileId: "table",
        cardIds: [intent.cardId!],
      });
    }

    const nextPlayer: string | null = getOtherPlayer(playerId, players);

    const projected = projectPilesAfterEvents(state, engineEvents);
    const deckAfter = projected["deck"];
    const p1Hand = projected["P1-hand"];
    const p2Hand = projected["P2-hand"];
    const tableAfter = projected["table"];

    const deckEmpty = !deckAfter || deckAfter.size === 0;
    const handsEmpty =
      (!p1Hand || p1Hand.size === 0) && (!p2Hand || p2Hand.size === 0);

    if (handsEmpty) {
      if (!deckEmpty) {
        const dealEvents = dealCards(state, nextRulesState);
        engineEvents.push(...dealEvents);
        engineEvents.push({
          type: "set-current-player",
          player: nextPlayer,
        });

        nextRulesState = {
          ...nextRulesState,
          phase: "playing",
        };

        const projectedAfterDeal = projectPilesAfterEvents(state, engineEvents);
        const sb = buildScoreboard(projectedAfterDeal, nextRulesState);
        engineEvents.push({
          type: "set-scoreboards",
          scoreboards: [sb],
        });
      } else {
        const lastCapturer = nextRulesState.lastCapturer;
        const table = tableAfter;

        if (lastCapturer && table && table.size > 0 && table.cardIds) {
          engineEvents.push({
            type: "move-cards",
            fromPileId: "table",
            toPileId: `${lastCapturer}-won`,
            cardIds: [...table.cardIds] as [number, ...number[]],
          });
        }

        const finalProjected = projectPilesAfterEvents(state, engineEvents);
        const finalScores = computeScores(finalProjected, nextRulesState);
        const scoreLine = players
          .map((p) => `${p}: ${finalScores[p].totalPoints} pts`)
          .join(", ");

        nextRulesState.result = `Hand ${nextRulesState.dealNumber} Result: ${scoreLine}.`;
        nextRulesState.phase = "ended";
        nextRulesState.hasDealt = false;

        const sb = buildScoreboard(finalProjected, nextRulesState);
        const winner = determineWinner(finalProjected, nextRulesState);

        engineEvents.push({
          type: "set-scoreboards",
          scoreboards: [sb],
        });

        if (winner) {
          engineEvents.push({
            type: "set-winner",
            winner,
          });
        }

        // Standard gather for next hand
        engineEvents.push(
          ...gatherAllCards(state, { previousEvents: engineEvents })
        );

        // Reset all hand visibilities to owner-only for the next deal
        for (const player of nextRulesState.players) {
          engineEvents.push({
            type: "set-pile-visibility",
            pileId: `${player}-hand`,
            visibility: "owner",
          });
        }
      }
    } else {
      const sb = buildScoreboard(projected, nextRulesState);
      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: [sb],
      });

      engineEvents.push({
        type: "set-current-player",
        player: nextPlayer,
      });
    }

    engineEvents.push({
      type: "set-rules-state",
      rulesState: {
        ...nextRulesState,
      },
    });

    return { valid: true, engineEvents };
  },
};

export const scopaPlugin: GamePlugin = {
  id: "scopa",
  gameName: META.gameName,
  ruleModule: scopaRules,
  description: META.description,
  validationHints: {
    sharedPileIds: ["table", "deck"],
  } satisfies ValidationHints,
};
