import type { GameRuleModule, GamePlugin } from "../interface.js";
import type {
  ValidationState,
  ValidationPileSummary,
} from "../../validation-state.js";
import type {
  ClientIntent,
  GameState,
  Scoreboard,
} from "../../../../shared/schemas.js";
import type {
  EngineEvent,
  ValidationResult,
} from "../../../../shared/validation.js";
import { loadGameMeta } from "../meta.js";
import { appendHistoryDigest, type AgentGuide } from "../util/agent-guide.js";
import { projectPilesAfterEvents, type ProjectedPiles } from "../util/piles.js";
import {
  gatherAllCards,
  shuffleAllCards,
  distributeRoundRobin,
} from "../util/dealing.js";

/**
 * AI support:
 *
 * This rule module implements `listLegalIntentsForPlayer`, which returns the set
 * of legal ClientIntents for a given player in the current state.
 *
 * In particular, it uses `rulesState` to enforce turn/phase restrictions
 * (e.g. in Gin Rummy: "must-draw" vs "must-discard"), so the AI layer does
 * not need any game-specific logic.
 */

const META = loadGameMeta("gin-rummy");

type GinPhase =
  | "dealing"
  | "first-upcard-non-dealer"
  | "first-upcard-dealer"
  | "playing"
  | "ended";
type TurnPhase = "must-draw" | "must-discard";

interface GinRulesState {
  phase: GinPhase;
  hasDealt: boolean;
  dealNumber: number;
  players: string[];
  dealer: string; // The player who dealt this hand
  turnPhase: TurnPhase;
  lastDrawnCardId: number | null;
  lastDrawSource: "deck" | "discard" | null;
  knockPlayer: string | null;
  knockType: "none" | "knock" | "gin" | "blocked";
  result: string | null;

  // Match-level state
  matchScores: Record<string, number>;
  handWins: Record<string, number>;
  matchWinner: string | null;
  agentGuide?: AgentGuide;
}

type SimpleCard = { id: number; rank: string; suit: string };

const DEADWOOD_VALUE: Record<string, number> = {
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
const RANK_TO_NUM: Record<string, number> = Object.fromEntries(
  RANK_ORDER.map((r, i) => [r, i + 1])
);

const GIN_BONUS = 25;
const UNDERCUT_BONUS = 25;
const MAX_KNOCK_DEADWOOD = 10;
const MATCH_POINTS_GOAL = 100;

// -------- basic helpers --------

function getGinRulesState(raw: unknown, players: string[]): GinRulesState {
  const validPlayers = players && players.length > 0 ? players : ["P1", "P2"];
  const base: GinRulesState = {
    phase: "dealing",
    hasDealt: false,
    dealNumber: 0,
    players: validPlayers,
    dealer: validPlayers[0],
    turnPhase: "must-draw",
    lastDrawnCardId: null,
    lastDrawSource: null,
    knockPlayer: null,
    knockType: "none",
    result: null,
    matchScores: Object.fromEntries(validPlayers.map((p) => [p, 0])),
    handWins: Object.fromEntries(validPlayers.map((p) => [p, 0])),
    matchWinner: null,
    agentGuide: { historyDigest: [] },
  };

  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Partial<GinRulesState>;

  return {
    ...base,
    ...obj,
    matchScores: obj.matchScores ?? base.matchScores,
    handWins: obj.handWins ?? base.handWins,
    agentGuide: obj.agentGuide ?? base.agentGuide,
  };
}

function getOtherPlayer(current: string, players: string[]): string {
  const idx = players.indexOf(current);
  if (idx === -1) return players[0] ?? current;
  return players[(idx + 1) % players.length];
}

function deadwoodValue(rank: string): number {
  return DEADWOOD_VALUE[rank] ?? 0;
}

function formatTurnDigest(
  playerId: string,
  rulesState: GinRulesState,
  discarded: { rank: string; suit: string }
): string {
  const drawLabel =
    rulesState.lastDrawSource === "discard"
      ? "drew from discard"
      : "drew from stock";
  return `${playerId}: ${drawLabel}, discarded ${formatCardLabel(discarded)}.`;
}

function formatCardLabel(card: { rank: string; suit: string }): string {
  return `${card.rank} of ${card.suit}`;
}

function projectPilesFromGameState(gameState: GameState): ProjectedPiles {
  const piles: ProjectedPiles = {};
  for (const [pileId, pile] of Object.entries(gameState.piles)) {
    const cards = pile.cardIds
      .map((cid) => gameState.cards[cid])
      .filter(Boolean)
      .map((c) => ({ id: c.id, rank: c.rank, suit: c.suit }));

    piles[pileId] = {
      cardIds: [...pile.cardIds],
      cards,
      size: pile.cardIds.length,
    };
  }
  return piles;
}

function drawFromDeck(
  state: ValidationState,
  currentPlayer: string
): EngineEvent[] {
  const deck = state.piles["deck"];
  if (!deck || !deck.cards || deck.cards.length === 0) {
    throw new Error("[gin-rummy] cannot draw from empty deck");
  }
  const cards = deck.cards;
  const top = cards[cards.length - 1]; // treat last as top
  return [
    {
      type: "move-cards",
      fromPileId: "deck",
      toPileId: `${currentPlayer}-hand`,
      cardIds: [top.id],
    },
  ];
}

function drawFromDiscard(
  state: ValidationState,
  currentPlayer: string
): EngineEvent[] {
  const discard = state.piles["discard"];
  if (!discard || !discard.cards || discard.cards.length === 0) {
    throw new Error("[gin-rummy] cannot draw from empty discard");
  }
  const cards = discard.cards;
  const top = cards[cards.length - 1];
  return [
    {
      type: "move-cards",
      fromPileId: "discard",
      toPileId: `${currentPlayer}-hand`,
      cardIds: [top.id],
    },
  ];
}

// ------- meld search / scoring -------

type Meld = SimpleCard[];

type HandAnalysis = {
  melds: Meld[];
  deadwoodCards: SimpleCard[];
  deadwoodValue: number;
};

function generateMelds(cards: SimpleCard[]): number[][] {
  const n = cards.length;
  const melds: number[][] = [];

  // Sets: 3+ of same rank
  const byRank: Record<string, number[]> = {};
  for (let i = 0; i < n; i++) {
    const r = cards[i].rank;
    (byRank[r] ??= []).push(i);
  }
  for (const idxs of Object.values(byRank)) {
    if (idxs.length >= 3) {
      if (idxs.length === 3) {
        melds.push([...idxs]);
      } else if (idxs.length === 4) {
        for (let i = 0; i < 4; i++) {
          melds.push(idxs.filter((_, j) => j !== i));
        }
        melds.push([...idxs]);
      }
    }
  }

  // Runs: 3+ consecutive in same suit, Ace low only
  const bySuit: Record<string, number[]> = {};
  for (let i = 0; i < n; i++) {
    const s = cards[i].suit;
    (bySuit[s] ??= []).push(i);
  }

  for (const idxs of Object.values(bySuit)) {
    const sorted = [...idxs].sort(
      (a, b) => RANK_TO_NUM[cards[a].rank] - RANK_TO_NUM[cards[b].rank]
    );
    let start = 0;
    while (start < sorted.length) {
      let end = start;
      while (
        end + 1 < sorted.length &&
        RANK_TO_NUM[cards[sorted[end + 1]].rank] ===
          RANK_TO_NUM[cards[sorted[end]].rank] + 1
      ) {
        end++;
      }

      const len = end - start + 1;
      if (len >= 3) {
        for (let i = start; i <= end; i++) {
          for (let j = i + 2; j <= end; j++) {
            const run = sorted.slice(i, j + 1);
            melds.push(run);
          }
        }
      }

      start = end + 1;
    }
  }

  return melds;
}

function analyzeBestMelds(cards: SimpleCard[]): HandAnalysis {
  const n = cards.length;
  if (n === 0) {
    return { melds: [], deadwoodCards: [], deadwoodValue: 0 };
  }

  const meldIdxs = generateMelds(cards);

  if (meldIdxs.length === 0) {
    const deadVal = cards.reduce((sum, c) => sum + deadwoodValue(c.rank), 0);
    return { melds: [], deadwoodCards: [...cards], deadwoodValue: deadVal };
  }

  meldIdxs.sort((a, b) => b.length - a.length);

  let bestDeadwood = Infinity;
  let bestMask = 0;

  const cardValues = cards.map((c) => deadwoodValue(c.rank));

  function backtrack(i: number, usedMask: number) {
    if (i === meldIdxs.length) {
      let dead = 0;
      for (let k = 0; k < n; k++) {
        if (!(usedMask & (1 << k))) {
          dead += cardValues[k];
        }
      }
      if (dead < bestDeadwood) {
        bestDeadwood = dead;
        bestMask = usedMask;
      }
      return;
    }

    backtrack(i + 1, usedMask);

    const meld = meldIdxs[i];
    let mask = 0;
    for (const idx of meld) {
      const bit = 1 << idx;
      if (usedMask & bit) {
        return;
      }
      mask |= bit;
    }
    backtrack(i + 1, usedMask | mask);
  }

  backtrack(0, 0);

  const chosenMelds: Meld[] = [];
  const deadwoodCards: SimpleCard[] = [];

  let maskLeft = bestMask;
  for (const meld of meldIdxs) {
    const meldMask = meld.reduce((m, idx) => m | (1 << idx), 0);
    if ((maskLeft & meldMask) === meldMask) {
      chosenMelds.push(meld.map((i) => cards[i]));
      maskLeft &= ~meldMask;
    }
  }

  for (let k = 0; k < n; k++) {
    if (!(bestMask & (1 << k))) {
      deadwoodCards.push(cards[k]);
    }
  }

  return {
    melds: chosenMelds,
    deadwoodCards,
    deadwoodValue: bestDeadwood === Infinity ? 0 : bestDeadwood,
  };
}

function canLayOff(card: SimpleCard, melds: Meld[]): boolean {
  const rv = RANK_TO_NUM[card.rank];

  for (const meld of melds) {
    if (meld.length === 0) continue;
    const sameRank = meld.every((c) => c.rank === meld[0].rank);
    if (sameRank) {
      if (card.rank === meld[0].rank && meld.length < 4) {
        return true;
      }
      continue;
    }

    const suit = meld[0].suit;
    if (!meld.every((c) => c.suit === suit)) continue;

    const nums = meld.map((c) => RANK_TO_NUM[c.rank]).sort((a, b) => a - b);
    const min = nums[0];
    const max = nums[nums.length - 1];

    if (card.suit !== suit) continue;

    if (rv === min - 1 || rv === max + 1) {
      return true;
    }
  }

  return false;
}

// ------- Scoreboard and winner -------

type GinHandScore = {
  deadwood: Record<string, number>;
  handPoints: Record<string, number>;
  status: string;
};

function computeHandScore(
  projected: ProjectedPiles,
  rulesState: GinRulesState
): GinHandScore {
  const [p1, p2] = rulesState.players;

  const p1Cards = projected[`${p1}-hand`]?.cards ?? [];
  const p2Cards = projected[`${p2}-hand`]?.cards ?? [];

  const knockPlayer = rulesState.knockPlayer;
  const knockType = rulesState.knockType;

  const deadwood: Record<string, number> = { [p1]: 0, [p2]: 0 };
  const handPoints: Record<string, number> = { [p1]: 0, [p2]: 0 };
  let status = "";

  if (!knockPlayer || knockType === "blocked" || knockType === "none") {
    const a1 = analyzeBestMelds(p1Cards);
    const a2 = analyzeBestMelds(p2Cards);
    deadwood[p1] = a1.deadwoodValue;
    deadwood[p2] = a2.deadwoodValue;
    status =
      knockType === "blocked" ? "Blocked hand (no score)" : "In progress...";
    return { deadwood, handPoints, status };
  }

  const defender = knockPlayer === p1 ? p2 : p1;
  const knockerCards = knockPlayer === p1 ? p1Cards : p2Cards;
  const defenderCards = knockPlayer === p1 ? p2Cards : p1Cards;

  const knockerAnalysis = analyzeBestMelds(knockerCards);
  const defenderAnalysis = analyzeBestMelds(defenderCards);

  if (knockType === "gin") {
    deadwood[knockPlayer] = 0;
    deadwood[defender] = defenderAnalysis.deadwoodValue;
    const pts = GIN_BONUS + deadwood[defender];
    handPoints[knockPlayer] = pts;
    status = `Gin by ${knockPlayer}`;
    return { deadwood, handPoints, status };
  }

  const knockerMelds = knockerAnalysis.melds;
  let effectiveDefenderDeadwood = 0;

  for (const c of defenderAnalysis.deadwoodCards) {
    if (canLayOff(c, knockerMelds)) {
      continue;
    }
    effectiveDefenderDeadwood += deadwoodValue(c.rank);
  }

  const knockerDeadwood = knockerAnalysis.deadwoodValue;
  deadwood[knockPlayer] = knockerDeadwood;
  deadwood[defender] = effectiveDefenderDeadwood;

  if (knockerDeadwood < effectiveDefenderDeadwood) {
    const pts = effectiveDefenderDeadwood - knockerDeadwood;
    handPoints[knockPlayer] = pts;
    status = `Knock by ${knockPlayer}`;
  } else {
    const diff = knockerDeadwood - effectiveDefenderDeadwood;
    const pts = UNDERCUT_BONUS + diff;
    handPoints[defender] = pts;
    status = `Undercut by ${defender}`;
  }

  return { deadwood, handPoints, status };
}

function calculateMatchTotals(rulesState: GinRulesState): {
  scores: Record<string, number>;
  bonus: Record<string, string>;
} {
  const totals: Record<string, number> = {};
  const bonusDesc: Record<string, string> = {};

  for (const p of rulesState.players) {
    let score = rulesState.matchScores[p];
    const wins = rulesState.handWins[p];

    const isWinner = rulesState.matchWinner === p;
    if (isWinner) {
      const other = getOtherPlayer(p, rulesState.players);
      const opponentScore = rulesState.matchScores[other];

      let gameBonus = 100;
      let boxesBonus = wins * 25;

      if (opponentScore === 0) {
        gameBonus *= 2;
        boxesBonus *= 2;
        bonusDesc[p] = "Shutout! ";
      }

      score += gameBonus + boxesBonus;
      bonusDesc[p] =
        (bonusDesc[p] ?? "") + `Game +${gameBonus}, Boxes +${boxesBonus}`;
    } else if (rulesState.matchWinner) {
      const boxesBonus = wins * 25;
      score += boxesBonus;
      bonusDesc[p] = `Boxes +${boxesBonus}`;
    }

    totals[p] = score;
  }

  return { scores: totals, bonus: bonusDesc };
}

function buildScoreboard(
  projected: ProjectedPiles,
  rulesState: GinRulesState,
  viewerId: string
): Scoreboard[] {
  const players = rulesState.players;
  const { deadwood, handPoints, status } = computeHandScore(
    projected,
    rulesState
  );
  const { scores: matchTotals, bonus: matchBonuses } =
    calculateMatchTotals(rulesState);

  const canSeePrivateFor = (pid: string) => {
    if (viewerId === "__god__") return true;
    if (rulesState.phase === "ended") return true;
    return viewerId === pid;
  };

  const handScore: Scoreboard = {
    id: "gin-rummy-hand",
    title: "Current Hand",
    rows: 4,
    cols: players.length + 1,
    cells: [
      { row: 0, col: 0, text: "Category", role: "header" },
      ...players.map((p, i) => ({
        row: 0,
        col: i + 1,
        text: p,
        role: "header" as const,
        align: "center" as const,
      })),

      { row: 1, col: 0, text: "Deadwood", role: "body" },
      ...players.map((p, i) => ({
        row: 1,
        col: i + 1,
        text: canSeePrivateFor(p) ? String(deadwood[p]) : "—",
        role: "body" as const,
        align: "center" as const,
      })),

      { row: 2, col: 0, text: "Points", role: "total" },
      ...players.map((p, i) => ({
        row: 2,
        col: i + 1,
        text: String(handPoints[p]),
        role: "total" as const,
        align: "center" as const,
      })),

      { row: 3, col: 0, text: "Status", role: "body" },
      {
        row: 3,
        col: 1,
        text: status,
        role: "body",
        align: "left",
        colspan: players.length,
      },
    ],
  };

  const matchScore: Scoreboard = {
    id: "gin-rummy-match",
    title: "Match Score (Goal: 100)",
    rows: 4,
    cols: players.length + 1,
    cells: [
      { row: 0, col: 0, text: "Player", role: "header" },
      ...players.map((p, i) => ({
        row: 0,
        col: i + 1,
        text: p,
        role: "header" as const,
        align: "center" as const,
      })),

      { row: 1, col: 0, text: "Base Score", role: "body" },
      ...players.map((p, i) => ({
        row: 1,
        col: i + 1,
        text: String(rulesState.matchScores[p]),
        role: "body" as const,
        align: "center" as const,
      })),

      { row: 2, col: 0, text: "Bonuses", role: "body" },
      ...players.map((p, i) => ({
        row: 2,
        col: i + 1,
        text: matchBonuses[p] || "—",
        role: "body" as const,
        align: "center" as const,
      })),

      { row: 3, col: 0, text: "Total", role: "total" },
      ...players.map((p, i) => ({
        row: 3,
        col: i + 1,
        text: String(matchTotals[p]),
        role: "total" as const,
        align: "center" as const,
      })),
    ],
  };

  return [handScore, matchScore];
}

function topCardId(pile: ValidationPileSummary | null): number | null {
  if (!pile || !pile.topCard) return null;
  return pile.topCard.id;
}

function cardsInPile(state: ValidationState, pileId: string): SimpleCard[] {
  const pile = state.piles[pileId];
  if (!pile?.cards) return [];
  return pile.cards;
}

function findHandPileIdForPlayer(
  state: ValidationState,
  playerId: string
): string {
  return `${playerId}-hand`;
}

// ------- Action derivation -------

function deriveActions(
  state: ValidationState,
  rulesState: GinRulesState,
  currentPlayerId: string | null
) {
  if (rulesState.phase === "ended" || rulesState.matchWinner)
    return { rows: 0, cols: 0, cells: [] };
  if (!currentPlayerId) return { rows: 0, cols: 0, cells: [] };

  const cells: {
    id: string;
    label: string;
    actionId: string;
    row: number;
    col: number;
    enabled: boolean;
  }[] = [];

  if (
    rulesState.phase === "first-upcard-non-dealer" ||
    rulesState.phase === "first-upcard-dealer"
  ) {
    cells.push({
      id: "take-upcard",
      label: "Take Upcard",
      actionId: "take-upcard",
      row: 0,
      col: 0,
      enabled: true,
    });
    cells.push({
      id: "pass-upcard",
      label: "Pass",
      actionId: "pass-upcard",
      row: 0,
      col: 1,
      enabled: true,
    });
  } else if (
    rulesState.phase === "playing" &&
    rulesState.turnPhase === "must-discard"
  ) {
    const hand = cardsInPile(state, `${currentPlayerId}-hand`);
    const analysis = analyzeBestMelds(hand);

    cells.push({
      id: "knock",
      label: "Knock",
      actionId: "knock",
      row: 0,
      col: 0,
      enabled: analysis.deadwoodValue <= MAX_KNOCK_DEADWOOD,
    });
    cells.push({
      id: "gin",
      label: "Go Gin",
      actionId: "gin",
      row: 0,
      col: 1,
      enabled: analysis.deadwoodValue === 0,
    });
  }

  return {
    rows: cells.length > 0 ? 1 : 0,
    cols: cells.length > 0 ? 2 : 0,
    cells,
  };
}

// ------- main rule module -------

export const ginRules: GameRuleModule = {
  deriveScoreboardsForView(
    gameState: GameState,
    viewerId: string
  ): Scoreboard[] {
    const players = gameState.players.map((p) => p.id);
    const rulesState = getGinRulesState(gameState.rulesState, players);
    const projected = projectPilesFromGameState(gameState);
    return buildScoreboard(projected, rulesState, viewerId);
  },

  listLegalIntentsForPlayer(
    state: ValidationState,
    playerId: string
  ): ClientIntent[] {
    const players = Object.keys(state.piles)
      .filter((id) => id.endsWith("-hand"))
      .map((id) => id.replace("-hand", ""))
      .sort();
    const rulesState = getGinRulesState(state.rulesState, players);
    const turnPhase = rulesState.turnPhase;

    const intents: ClientIntent[] = [];
    const gameId = state.gameId;

    if (
      state.winner ||
      rulesState.phase === "ended" ||
      rulesState.matchWinner
    ) {
      return intents;
    }

    if (!rulesState.hasDealt) {
      intents.push({ type: "action", gameId, playerId, action: "start-game" });
      return intents;
    }

    if (state.currentPlayer && state.currentPlayer !== playerId) {
      return intents;
    }

    if (
      rulesState.phase === "first-upcard-non-dealer" ||
      rulesState.phase === "first-upcard-dealer"
    ) {
      intents.push({ type: "action", gameId, playerId, action: "take-upcard" });
      intents.push({ type: "action", gameId, playerId, action: "pass-upcard" });
      return intents;
    }

    const playerHandPileId = findHandPileIdForPlayer(state, playerId);

    if (turnPhase === "must-draw") {
      const candidates: ClientIntent[] = [];
      const deckTop = topCardId(state.piles["deck"] ?? null);
      if (deckTop !== null) {
        candidates.push({
          type: "move",
          gameId,
          playerId,
          fromPileId: "deck",
          toPileId: playerHandPileId,
          cardId: deckTop,
        });
      }
      const discardTop = topCardId(state.piles["discard"] ?? null);
      if (discardTop !== null) {
        candidates.push({
          type: "move",
          gameId,
          playerId,
          fromPileId: "discard",
          toPileId: playerHandPileId,
          cardId: discardTop,
        });
      }
      for (const c of candidates) {
        if (this.validate(state, c).valid) {
          intents.push(c);
        }
      }
    } else if (turnPhase === "must-discard") {
      const handCards = cardsInPile(state, playerHandPileId);
      for (const card of handCards) {
        const candidate: ClientIntent = {
          type: "move",
          gameId,
          playerId,
          fromPileId: playerHandPileId,
          toPileId: "discard",
          cardId: card.id,
        };
        if (this.validate(state, candidate).valid) {
          intents.push(candidate);
        }
      }

      const analysis = analyzeBestMelds(handCards);
      if (analysis.deadwoodValue === 0) {
        intents.push({ type: "action", gameId, playerId, action: "gin" });
      }
      if (analysis.deadwoodValue <= MAX_KNOCK_DEADWOOD) {
        intents.push({ type: "action", gameId, playerId, action: "knock" });
      }
    }

    return intents;
  },

  validate(state: ValidationState, intent: ClientIntent): ValidationResult {
    const players = Object.keys(state.piles)
      .filter((id) => id.endsWith("-hand"))
      .map((id) => id.replace("-hand", ""))
      .sort();
    const rulesState = getGinRulesState(state.rulesState, players);
    const engineEvents: EngineEvent[] = [];
    let nextRulesState: GinRulesState = { ...rulesState };
    let historyEntry: string | null = null;

    if (!rulesState.hasDealt) {
      if (intent.type !== "action" || intent.action !== "start-game") {
        return {
          valid: false,
          reason: "Game has not started. Use the Start Game action.",
          engineEvents: [],
        };
      }

      let dealer = rulesState.dealer;
      if (rulesState.dealNumber === 0) {
        dealer = players[0];
      }

      const nextDealNumber = rulesState.dealNumber + 1;

      engineEvents.push(...gatherAllCards(state));

      const shuffledCardIds = shuffleAllCards(state, nextDealNumber, "GIN");

      nextRulesState = {
        ...rulesState,
        hasDealt: true,
        dealNumber: nextDealNumber,
        dealer,
        phase: "first-upcard-non-dealer",
        turnPhase: "must-draw",
        lastDrawnCardId: null,
        lastDrawSource: null,
        knockPlayer: null,
        knockType: "none",
        result: null,
      };

      // Collapse history when starting new hand
      nextRulesState.agentGuide = appendHistoryDigest(
        nextRulesState.agentGuide,
        `Hand ${nextDealNumber} started (dealer ${dealer}).`,
        { summarizePrevious: rulesState.result || undefined }
      );

      const { events: dealEvents, nextIndex: afterDealIdx } =
        distributeRoundRobin(
          shuffledCardIds,
          players.map((p) => `${p}-hand`),
          10
        );
      engineEvents.push(...dealEvents);

      engineEvents.push({
        type: "move-cards",
        fromPileId: "deck",
        toPileId: "discard",
        cardIds: [shuffledCardIds[afterDealIdx]],
      });
      const nonDealer = getOtherPlayer(dealer, players);
      engineEvents.push({ type: "set-current-player", player: nonDealer });
      engineEvents.push({
        type: "set-pile-visibility",
        pileId: "deck",
        visibility: "hidden",
      });
      engineEvents.push({
        type: "set-rules-state",
        rulesState: nextRulesState,
      });
      engineEvents.push({
        type: "set-actions",
        actions: deriveActions(state, nextRulesState, nonDealer),
      });
      const projected = projectPilesAfterEvents(state, engineEvents);
      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: buildScoreboard(
          projected,
          nextRulesState,
          "__spectator__"
        ),
      });

      return { valid: true, engineEvents };
    }

    if (rulesState.phase === "ended" || rulesState.matchWinner) {
      return {
        valid: false,
        reason: "Hand has already ended.",
        engineEvents: [],
      };
    }

    const currentPlayer = state.currentPlayer;
    if (!currentPlayer || !players.includes(currentPlayer)) {
      return {
        valid: false,
        reason: "Invalid current player.",
        engineEvents: [],
      };
    }

    if (intent.type === "action") {
      if (rulesState.phase === "first-upcard-non-dealer") {
        if (intent.action === "take-upcard") {
          engineEvents.push(...drawFromDiscard(state, currentPlayer));
          nextRulesState = {
            ...nextRulesState,
            phase: "playing",
            turnPhase: "must-discard",
            lastDrawSource: "discard",
          };
          historyEntry = `${currentPlayer} took the upcard.`;
        } else if (intent.action === "pass-upcard") {
          const dealer = rulesState.dealer;
          nextRulesState = { ...nextRulesState, phase: "first-upcard-dealer" };
          engineEvents.push({ type: "set-current-player", player: dealer });
          historyEntry = `${currentPlayer} passed the upcard.`;
        } else
          return { valid: false, reason: "Invalid action.", engineEvents: [] };
      } else if (rulesState.phase === "first-upcard-dealer") {
        if (intent.action === "take-upcard") {
          engineEvents.push(...drawFromDiscard(state, currentPlayer));
          nextRulesState = {
            ...nextRulesState,
            phase: "playing",
            turnPhase: "must-discard",
            lastDrawSource: "discard",
          };
          historyEntry = `${currentPlayer} took the upcard.`;
        } else if (intent.action === "pass-upcard") {
          const nonDealer = getOtherPlayer(rulesState.dealer, players);
          nextRulesState = {
            ...nextRulesState,
            phase: "playing",
            turnPhase: "must-draw",
          };
          engineEvents.push({ type: "set-current-player", player: nonDealer });
          historyEntry = `${currentPlayer} passed the upcard.`;
        } else
          return { valid: false, reason: "Invalid action.", engineEvents: [] };
      } else if (
        rulesState.phase === "playing" &&
        rulesState.turnPhase === "must-discard"
      ) {
        const hand = cardsInPile(state, `${currentPlayer}-hand`);
        const analysis = analyzeBestMelds(hand);

        if (intent.action === "gin") {
          if (analysis.deadwoodValue !== 0)
            return {
              valid: false,
              reason: "You can only go Gin with 0 deadwood.",
              engineEvents: [],
            };
          nextRulesState = {
            ...nextRulesState,
            knockType: "gin",
            knockPlayer: currentPlayer,
          };
          historyEntry = `${currentPlayer} went gin.`;
        } else if (intent.action === "knock") {
          if (analysis.deadwoodValue > MAX_KNOCK_DEADWOOD)
            return {
              valid: false,
              reason: `You need ${MAX_KNOCK_DEADWOOD} or fewer deadwood to knock.`,
              engineEvents: [],
            };
          nextRulesState = {
            ...nextRulesState,
            knockType: "knock",
            knockPlayer: currentPlayer,
          };
          historyEntry = `${currentPlayer} knocked.`;
        } else
          return {
            valid: false,
            reason: "Action not available.",
            engineEvents: [],
          };

        nextRulesState = { ...nextRulesState, phase: "ended", hasDealt: false };
        const projected = projectPilesAfterEvents(state, engineEvents);
        const handScore = computeHandScore(projected, nextRulesState);

        // Store result for collapsing when next hand starts
        nextRulesState.result = `Hand ${rulesState.dealNumber} Result: ${handScore.status}. Scores: ${players[0]}=${handScore.handPoints[players[0]]}, ${players[1]}=${handScore.handPoints[players[1]]}.`;

        for (const p of players) {
          const pts = handScore.handPoints[p];
          if (pts > 0) {
            nextRulesState.matchScores[p] += pts;
            nextRulesState.handWins[p] += 1;
            nextRulesState.dealer = getOtherPlayer(p, players);

            if (nextRulesState.matchScores[p] >= MATCH_POINTS_GOAL) {
              nextRulesState.matchWinner = p;
            }
          }
        }

        engineEvents.push({ type: "set-current-player", player: null });
        if (nextRulesState.matchWinner)
          engineEvents.push({
            type: "set-winner",
            winner: nextRulesState.matchWinner,
          });
      } else {
        return {
          valid: false,
          reason: "Action not allowed now.",
          engineEvents: [],
        };
      }

      if (historyEntry) {
        nextRulesState.agentGuide = appendHistoryDigest(
          nextRulesState.agentGuide,
          historyEntry
        );
      }
      engineEvents.push({
        type: "set-rules-state",
        rulesState: nextRulesState,
      });
      engineEvents.push({
        type: "set-actions",
        actions: deriveActions(state, nextRulesState, state.currentPlayer),
      });
      const projected = projectPilesAfterEvents(state, engineEvents);
      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: buildScoreboard(
          projected,
          nextRulesState,
          "__spectator__"
        ),
      });
      return { valid: true, engineEvents };
    }

    if (intent.type === "move") {
      if (
        rulesState.phase !== "playing" &&
        rulesState.phase !== "first-upcard-non-dealer" &&
        rulesState.phase !== "first-upcard-dealer"
      ) {
        return {
          valid: false,
          reason: "Hand is not in play.",
          engineEvents: [],
        };
      }

      const from = intent.fromPileId;
      const to = intent.toPileId;
      const cardId = intent.cardId;

      const fromPile = state.piles[from];
      const movedCard = fromPile?.cards?.find((c) => c.id === cardId);
      if (!fromPile || !movedCard) {
        return {
          valid: false,
          reason: "Card not in source pile.",
          engineEvents: [],
        };
      }

      if (rulesState.turnPhase === "must-draw") {
        if (to !== `${currentPlayer}-hand`)
          return {
            valid: false,
            reason: "You must draw to your hand.",
            engineEvents: [],
          };

        if (from === "deck") {
          if (
            rulesState.phase === "first-upcard-non-dealer" ||
            rulesState.phase === "first-upcard-dealer"
          ) {
            return {
              valid: false,
              reason: "You must decide on the upcard first.",
              engineEvents: [],
            };
          }
          if (!state.piles["deck"] || state.piles["deck"].size === 0)
            return { valid: false, reason: "Deck is empty.", engineEvents: [] };
          engineEvents.push(...drawFromDeck(state, currentPlayer));
          nextRulesState = {
            ...nextRulesState,
            turnPhase: "must-discard",
            lastDrawSource: "deck",
          };
        } else if (from === "discard") {
          if (
            rulesState.phase === "first-upcard-non-dealer" ||
            rulesState.phase === "first-upcard-dealer"
          ) {
            return {
              valid: false,
              reason: "Use the 'Take Upcard' action.",
              engineEvents: [],
            };
          }
          engineEvents.push(...drawFromDiscard(state, currentPlayer));
          nextRulesState = {
            ...nextRulesState,
            turnPhase: "must-discard",
            lastDrawSource: "discard",
          };
        } else
          return {
            valid: false,
            reason: "Invalid draw source.",
            engineEvents: [],
          };
      } else {
        if (from !== `${currentPlayer}-hand` || to !== "discard")
          return {
            valid: false,
            reason: "Discard from hand to discard pile.",
            engineEvents: [],
          };

        engineEvents.push({
          type: "move-cards",
          fromPileId: `${currentPlayer}-hand`,
          toPileId: "discard",
          cardIds: [cardId],
        });
        historyEntry = formatTurnDigest(currentPlayer, rulesState, movedCard);

        const projected = projectPilesAfterEvents(state, engineEvents);
        if (projected["deck"].size <= 2) {
          nextRulesState = {
            ...nextRulesState,
            phase: "ended",
            hasDealt: false,
            knockType: "blocked",
          };
          nextRulesState.result = `Hand ${rulesState.dealNumber} Result: Blocked (deck empty). No points scored.`;
          engineEvents.push({ type: "set-current-player", player: null });
        } else {
          nextRulesState = { ...nextRulesState, turnPhase: "must-draw" };
          engineEvents.push({
            type: "set-current-player",
            player: getOtherPlayer(currentPlayer, players),
          });
        }
      }

      if (historyEntry) {
        nextRulesState.agentGuide = appendHistoryDigest(
          nextRulesState.agentGuide,
          historyEntry
        );
      }
      engineEvents.push({
        type: "set-rules-state",
        rulesState: nextRulesState,
      });
      engineEvents.push({
        type: "set-actions",
        actions: deriveActions(state, nextRulesState, state.currentPlayer),
      });
      const projected = projectPilesAfterEvents(state, engineEvents);
      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: buildScoreboard(
          projected,
          nextRulesState,
          "__spectator__"
        ),
      });
      return { valid: true, engineEvents };
    }

    return { valid: false, reason: "Unsupported intent.", engineEvents: [] };
  },
};

export const ginPlugin: GamePlugin = {
  id: "gin-rummy",
  gameName: META.gameName,
  ruleModule: ginRules,
  description: META.description,
  validationHints: {
    sharedPileIds: ["deck", "discard"],
    isPileAlwaysVisibleToRules: (pileId) => pileId.endsWith("-hand"),
  },
};
