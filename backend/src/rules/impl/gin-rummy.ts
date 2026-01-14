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
import type { AiView, AiContext } from "../../../../shared/src/ai/types.js";
import { loadGameMeta } from "../meta.js";
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
  | "layoff"
  | "ended";
type TurnPhase = "must-draw" | "must-discard";

/** Returns a user-friendly explanation of what moves are allowed in the current phase. */
function getPhaseGuidance(phase: GinPhase, turnPhase: TurnPhase): string {
  switch (phase) {
    case "dealing":
      return "The game has not started yet. Use the Start Game action to deal cards.";
    case "first-upcard-non-dealer":
      return "The non-dealer may take the upcard to start their turn, or pass to give the dealer a chance.";
    case "first-upcard-dealer":
      return "The dealer may take the upcard to start their turn, or pass to let the non-dealer draw from the deck.";
    case "playing":
      return turnPhase === "must-draw"
        ? "You must draw a card from the deck or take the top card from the discard pile."
        : "You may arrange melds in your meld piles, then discard a card to end your turn.";
    case "layoff":
      return "The defender may lay off cards onto the knocker's melds. Click Finish when done.";
    case "ended":
      return "This hand has ended.";
  }
}

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
  layoffCardIds: number[];
  result: string | null;

  // Match-level state
  matchScores: Record<string, number>;
  handWins: Record<string, number>;
  matchWinner: string | null;

  // AI context: turn-by-turn summaries
  recap: string[];
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
const MELD_SLOTS = [1, 2, 3];

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
    layoffCardIds: [],
    result: null,
    matchScores: Object.fromEntries(validPlayers.map((p) => [p, 0])),
    handWins: Object.fromEntries(validPlayers.map((p) => [p, 0])),
    matchWinner: null,
    recap: [],
  };

  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Partial<GinRulesState>;

  return {
    ...base,
    ...obj,
    matchScores: obj.matchScores ?? base.matchScores,
    handWins: obj.handWins ?? base.handWins,
    layoffCardIds: Array.isArray(obj.layoffCardIds)
      ? obj.layoffCardIds.filter((id): id is number => typeof id === "number")
      : base.layoffCardIds,
    recap: Array.isArray(obj.recap) ? obj.recap : base.recap,
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

function rankNumber(rank: string): number {
  const idx = RANK_ORDER.indexOf(rank);
  return idx === -1 ? -1 : idx + 1;
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

function meldPileId(playerId: string, index: number): string {
  return `${playerId}-meld-${index}`;
}

function meldPileIdsForPlayer(playerId: string): string[] {
  return MELD_SLOTS.map((index) => meldPileId(playerId, index));
}

function isPlayerMeldPile(pileId: string, playerId: string): boolean {
  return pileId.startsWith(`${playerId}-meld-`);
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

function minDeadwoodAfterDiscard(cards: SimpleCard[]): number {
  if (cards.length === 0) return 0;
  let best = Infinity;
  for (const card of cards) {
    const remaining = cards.filter((c) => c.id !== card.id);
    const analysis = analyzeBestMelds(remaining);
    if (analysis.deadwoodValue < best) {
      best = analysis.deadwoodValue;
    }
  }
  return best === Infinity ? 0 : best;
}

function validateMeld(cards: SimpleCard[]): string | null {
  if (cards.length < 3) {
    return "Melds must contain at least three cards.";
  }

  const sameRank = cards.every((c) => c.rank === cards[0].rank);
  if (sameRank) {
    if (cards.length > 4) {
      return "Sets cannot have more than four cards.";
    }
    return null;
  }

  const sameSuit = cards.every((c) => c.suit === cards[0].suit);
  if (!sameSuit) {
    return "Melds must be a set or a single-suit run.";
  }

  const nums = cards.map((c) => RANK_TO_NUM[c.rank]).sort((a, b) => a - b);
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] !== nums[i - 1] + 1) {
      return "Run melds must be consecutive.";
    }
  }

  return null;
}

function canAddToMeld(meldCards: SimpleCard[], card: SimpleCard): boolean {
  if (meldCards.length === 0) return true;
  if (meldCards.length === 1) {
    const base = meldCards[0];
    if (card.rank === base.rank) {
      return true;
    }
    if (card.suit !== base.suit) return false;
    const baseNum = rankNumber(base.rank);
    const cardNum = rankNumber(card.rank);
    if (baseNum === -1 || cardNum === -1) return false;
    return cardNum === baseNum - 1 || cardNum === baseNum + 1;
  }

  const sameRank = meldCards.every((c) => c.rank === meldCards[0].rank);
  if (sameRank) {
    if (card.rank !== meldCards[0].rank) return false;
    const size = meldCards.length + 1;
    return size <= 4;
  }

  const sameSuit = meldCards.every((c) => c.suit === meldCards[0].suit);
  if (!sameSuit || card.suit !== meldCards[0].suit) return false;

  const nums = meldCards.map((c) => rankNumber(c.rank)).sort((a, b) => a - b);
  const min = nums[0];
  const max = nums[nums.length - 1];
  const rv = rankNumber(card.rank);
  if (rv === -1 || min === -1 || max === -1) return false;

  if (meldCards.length === 1) {
    return rv === min - 1 || rv === max + 1;
  }

  return rv === min - 1 || rv === max + 1;
}

function hasExistingSetMeld(
  state: ValidationState,
  playerId: string,
  rank: string
): boolean {
  for (const pileId of meldPileIdsForPlayer(playerId)) {
    const cards = cardsInPile(state, pileId);
    if (cards.length === 0) continue;
    if (cards.every((c) => c.rank === rank)) {
      return true;
    }
  }
  return false;
}

type MeldInfo = {
  melds: Meld[];
  meldCards: SimpleCard[];
  invalidReason: string | null;
};

function collectMeldInfo(
  projected: ProjectedPiles,
  playerId: string
): MeldInfo {
  const melds: Meld[] = [];
  const meldCards: SimpleCard[] = [];
  let invalidReason: string | null = null;

  for (const pileId of meldPileIdsForPlayer(playerId)) {
    const cards = projected[pileId]?.cards ?? [];
    if (cards.length === 0) continue;
    meldCards.push(...cards);
    const err = validateMeld(cards);
    if (err) {
      invalidReason ??= `Meld pile ${pileId} is invalid. ${err}`;
    } else {
      melds.push(cards);
    }
  }

  return { melds, meldCards, invalidReason };
}

function computeDeadwoodForScoreboard(
  projected: ProjectedPiles,
  playerId: string
): HandAnalysis {
  const hand = projected[`${playerId}-hand`]?.cards ?? [];
  const meldInfo = collectMeldInfo(projected, playerId);

  if (meldInfo.meldCards.length === 0) {
    return analyzeBestMelds(hand);
  }

  const deadwoodCards = meldInfo.invalidReason
    ? [...hand, ...meldInfo.meldCards]
    : [...hand];
  const deadwoodTotal = deadwoodCards.reduce(
    (sum, c) => sum + deadwoodValue(c.rank),
    0
  );

  return {
    melds: meldInfo.invalidReason ? [] : meldInfo.melds,
    deadwoodCards,
    deadwoodValue: deadwoodTotal,
  };
}

function computeDeadwoodManual(
  projected: ProjectedPiles,
  playerId: string
): { deadwoodValue: number; invalidReason: string | null } {
  const hand = projected[`${playerId}-hand`]?.cards ?? [];
  const meldInfo = collectMeldInfo(projected, playerId);
  const deadwoodCards = meldInfo.invalidReason
    ? [...hand, ...meldInfo.meldCards]
    : [...hand];
  const deadwoodTotal = deadwoodCards.reduce(
    (sum, c) => sum + deadwoodValue(c.rank),
    0
  );

  return {
    deadwoodValue: deadwoodTotal,
    invalidReason: meldInfo.invalidReason,
  };
}

function canLayOffToMeld(card: SimpleCard, meld: Meld): boolean {
  if (meld.length < 3) return false;
  if (validateMeld(meld)) return false;

  const sameRank = meld.every((c) => c.rank === meld[0].rank);
  if (sameRank) {
    return card.rank === meld[0].rank && meld.length < 4;
  }

  const suit = meld[0].suit;
  if (!meld.every((c) => c.suit === suit)) return false;
  if (card.suit !== suit) return false;

  const nums = meld.map((c) => RANK_TO_NUM[c.rank]).sort((a, b) => a - b);
  const min = nums[0];
  const max = nums[nums.length - 1];
  const rv = RANK_TO_NUM[card.rank];

  return rv === min - 1 || rv === max + 1;
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

  const knockPlayer = rulesState.knockPlayer;
  const knockType = rulesState.knockType;

  const deadwood: Record<string, number> = { [p1]: 0, [p2]: 0 };
  const handPoints: Record<string, number> = { [p1]: 0, [p2]: 0 };
  let status = "";

  if (!knockPlayer || knockType === "blocked" || knockType === "none") {
    const a1 = computeDeadwoodForScoreboard(projected, p1);
    const a2 = computeDeadwoodForScoreboard(projected, p2);
    deadwood[p1] = a1.deadwoodValue;
    deadwood[p2] = a2.deadwoodValue;
    status =
      knockType === "blocked" ? "Blocked hand (no score)" : "In progress";
    return { deadwood, handPoints, status };
  }

  const defender = knockPlayer === p1 ? p2 : p1;
  const knockerHand = projected[`${knockPlayer}-hand`]?.cards ?? [];
  const knockerDeadwood = knockerHand.reduce(
    (sum, c) => sum + deadwoodValue(c.rank),
    0
  );
  const defenderAnalysis =
    knockType === "knock"
      ? computeDeadwoodManual(projected, defender)
      : computeDeadwoodForScoreboard(projected, defender);

  if (knockType === "gin") {
    deadwood[knockPlayer] = 0;
    deadwood[defender] = defenderAnalysis.deadwoodValue;
    const pts = GIN_BONUS + deadwood[defender];
    handPoints[knockPlayer] = pts;
    status = `Gin by ${knockPlayer}`;
    return { deadwood, handPoints, status };
  }

  deadwood[knockPlayer] = knockerDeadwood;
  deadwood[defender] = defenderAnalysis.deadwoodValue;

  if (knockerDeadwood < defenderAnalysis.deadwoodValue) {
    const pts = defenderAnalysis.deadwoodValue - knockerDeadwood;
    handPoints[knockPlayer] = pts;
    status = `Knock by ${knockPlayer}`;
  } else {
    const diff = knockerDeadwood - defenderAnalysis.deadwoodValue;
    const pts = UNDERCUT_BONUS + diff;
    handPoints[defender] = pts;
    status = `Undercut by ${defender}`;
  }

  if (rulesState.phase === "layoff") {
    status = `Layoff in progress (knock by ${knockPlayer})`;
  }

  return { deadwood, handPoints, status };
}

function finalizeHand(
  state: ValidationState,
  rulesState: GinRulesState,
  engineEvents: EngineEvent[]
): GinRulesState {
  const projected = projectPilesAfterEvents(state, engineEvents);
  const scoringState: GinRulesState = { ...rulesState, phase: "ended" };
  const handScore = computeHandScore(projected, scoringState);

  // Collapse recap to hand summary
  const [p1, p2] = rulesState.players;
  const handSummary = `Hand ${rulesState.dealNumber}: ${handScore.status}. Points: ${p1}=${handScore.handPoints[p1]}, ${p2}=${handScore.handPoints[p2]}.`;

  const nextRulesState: GinRulesState = {
    ...scoringState,
    hasDealt: false,
    layoffCardIds: [],
    result: `Hand ${rulesState.dealNumber} Result: ${handScore.status}. Scores: ${rulesState.players[0]}=${handScore.handPoints[rulesState.players[0]]}, ${rulesState.players[1]}=${handScore.handPoints[rulesState.players[1]]}.`,
    recap: [handSummary],
  };

  for (const p of rulesState.players) {
    const pts = handScore.handPoints[p];
    if (pts > 0) {
      nextRulesState.matchScores[p] += pts;
      nextRulesState.handWins[p] += 1;
      nextRulesState.dealer = getOtherPlayer(p, rulesState.players);

      if (nextRulesState.matchScores[p] >= MATCH_POINTS_GOAL) {
        nextRulesState.matchWinner = p;
      }
    }
  }

  engineEvents.push({ type: "set-current-player", player: null });
  if (nextRulesState.matchWinner) {
    engineEvents.push({
      type: "set-winner",
      winner: nextRulesState.matchWinner,
    });
  }

  return nextRulesState;
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
      id: "pass",
      label: "Pass",
      actionId: "pass",
      row: 0,
      col: 0,
      enabled: true,
    });
  } else if (rulesState.phase === "layoff") {
    cells.push({
      id: "finish",
      label: "Finish",
      actionId: "finish",
      row: 0,
      col: 0,
      enabled: true,
    });
  }

  return {
    rows: cells.length > 0 ? 1 : 0,
    cols: cells.length > 0 ? 1 : 0,
    cells,
  };
}

// ------- main rule module -------

/**
 * Generate multi-card meld candidates from a hand.
 * Returns arrays of card IDs that form valid sets or runs.
 *
 * Rules:
 * - Set: 3+ cards of same rank
 * - Run: 3+ consecutive same suit
 */
function generateGinMeldCandidates(hand: SimpleCard[]): number[][] {
  if (hand.length < 3) return [];

  const melds: number[][] = [];

  // Generate sets (3+ same rank)
  const byRank = new Map<string, SimpleCard[]>();
  for (const card of hand) {
    if (!byRank.has(card.rank)) byRank.set(card.rank, []);
    byRank.get(card.rank)!.push(card);
  }

  for (const cards of byRank.values()) {
    if (cards.length >= 3) {
      // Generate all sizes from 3 to max
      for (let size = 3; size <= cards.length; size++) {
        melds.push(cards.slice(0, size).map((c) => c.id));
      }
    }
  }

  // Generate runs (3+ consecutive same suit)
  const bySuit = new Map<string, SimpleCard[]>();
  for (const card of hand) {
    if (!bySuit.has(card.suit)) bySuit.set(card.suit, []);
    bySuit.get(card.suit)!.push(card);
  }

  for (const cards of bySuit.values()) {
    if (cards.length < 3) continue;

    // Sort by rank value
    const sorted = cards
      .map((c) => ({ card: c, rankNum: RANK_TO_NUM[c.rank] ?? 0 }))
      .sort((a, b) => a.rankNum - b.rankNum);

    // Find consecutive sequences
    let start = 0;
    while (start < sorted.length) {
      let end = start;
      while (
        end + 1 < sorted.length &&
        sorted[end + 1].rankNum === sorted[end].rankNum + 1
      ) {
        end++;
      }

      const len = end - start + 1;
      if (len >= 3) {
        // Generate all runs of length 3 or more from this sequence
        for (let runStart = start; runStart <= end - 2; runStart++) {
          for (let runEnd = runStart + 2; runEnd <= end; runEnd++) {
            const run = sorted
              .slice(runStart, runEnd + 1)
              .map((item) => item.card.id);
            melds.push(run);
          }
        }
      }

      start = end + 1;
    }
  }

  return melds;
}

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
      intents.push({ type: "action", gameId, playerId, action: "pass" });
      const playerHandPileId = findHandPileIdForPlayer(state, playerId);
      const discardTop = topCardId(state.piles["discard"] ?? null);
      if (discardTop !== null) {
        intents.push({
          type: "move",
          gameId,
          playerId,
          fromPileId: "discard",
          toPileId: playerHandPileId,
          cardId: discardTop,
        });
      }
      return intents.filter((intent) => this.validate(state, intent).valid);
    }

    if (rulesState.phase === "layoff") {
      if (rulesState.knockType !== "knock" || !rulesState.knockPlayer) {
        return intents;
      }
      const defender = getOtherPlayer(rulesState.knockPlayer, players);
      if (defender !== playerId) return intents;

      intents.push({ type: "action", gameId, playerId, action: "finish" });

      const handPileId = findHandPileIdForPlayer(state, playerId);
      const handCards = cardsInPile(state, handPileId);
      const knocker = rulesState.knockPlayer;
      const defenderMelds = meldPileIdsForPlayer(defender);

      // Generate multi-card meld candidates for defender's own melds
      // This allows the AI to form new melds efficiently to reduce deadwood
      const meldCandidates = generateGinMeldCandidates(handCards);
      const cardsCoveredByMultiMeld = new Set<number>();
      for (const cardIds of meldCandidates) {
        for (const meldPileId of defenderMelds) {
          const pileSize = state.piles[meldPileId]?.size ?? 0;
          if (pileSize === 0) {
            const candidate: ClientIntent = {
              type: "move",
              gameId,
              playerId,
              fromPileId: handPileId,
              toPileId: meldPileId,
              cardIds,
            };
            if (this.validate(state, candidate).valid) {
              intents.push(candidate);
              // Track cards covered by this multi-card meld
              for (const id of cardIds) {
                cardsCoveredByMultiMeld.add(id);
              }
            }
            break; // Only add to first empty meld pile
          }
        }
      }

      // Single card layoffs to knocker's melds (always needed - these are layoffs)
      for (const card of handCards) {
        for (const meldPileId of meldPileIdsForPlayer(knocker)) {
          const candidate: ClientIntent = {
            type: "move",
            gameId,
            playerId,
            fromPileId: handPileId,
            toPileId: meldPileId,
            cardId: card.id,
          };
          if (this.validate(state, candidate).valid) {
            intents.push(candidate);
          }
        }
      }

      // Single card moves to defender's own melds (extending only)
      // Skip cards already covered by multi-card meld candidates (reduces AI noise)
      for (const card of handCards) {
        if (cardsCoveredByMultiMeld.has(card.id)) continue;
        for (const meldPileId of defenderMelds) {
          const existingMeldSize = state.piles[meldPileId]?.size ?? 0;
          // Only allow single-card additions to existing melds with 3+ cards
          if (existingMeldSize < 3) continue;
          const candidate: ClientIntent = {
            type: "move",
            gameId,
            playerId,
            fromPileId: handPileId,
            toPileId: meldPileId,
            cardId: card.id,
          };
          if (this.validate(state, candidate).valid) {
            intents.push(candidate);
          }
        }
      }

      // Allow taking cards back from defender's own melds, but only if remaining cards form valid meld
      for (const meldPileId of defenderMelds) {
        const meldCards = cardsInPile(state, meldPileId);
        for (const card of meldCards) {
          // Check if remaining cards would still form a valid meld (3+ cards)
          const remainingCards = meldCards.filter((c) => c.id !== card.id);
          if (remainingCards.length > 0 && remainingCards.length < 3) {
            // Would leave invalid meld, skip this candidate
            continue;
          }
          const candidate: ClientIntent = {
            type: "move",
            gameId,
            playerId,
            fromPileId: meldPileId,
            toPileId: handPileId,
            cardId: card.id,
          };
          if (this.validate(state, candidate).valid) {
            intents.push(candidate);
          }
        }
      }

      for (const fromMeld of defenderMelds) {
        const fromCards = cardsInPile(state, fromMeld);
        for (const card of fromCards) {
          for (const toMeld of defenderMelds) {
            if (fromMeld === toMeld) continue;
            // Skip single-card moves to empty meld piles (prevents breaking up melds)
            const toMeldCards = cardsInPile(state, toMeld);
            if (toMeldCards.length === 0) continue;
            const candidate: ClientIntent = {
              type: "move",
              gameId,
              playerId,
              fromPileId: fromMeld,
              toPileId: toMeld,
              cardId: card.id,
            };
            if (this.validate(state, candidate).valid) {
              intents.push(candidate);
            }
          }
        }
      }

      // Note: Removed the illegal candidate generation that allowed moving cards from knocker's melds to defender's hand
      // During layoff, the defender cannot take cards from the knocker's melds - they can only lay off their own cards

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

      // Generate multi-card meld candidates for AI efficiency
      const meldCandidates = generateGinMeldCandidates(handCards);
      const cardsCoveredByMultiMeld = new Set<number>();
      for (const cardIds of meldCandidates) {
        // Determine which meld pile to use - use first empty meld pile
        const meldPiles = meldPileIdsForPlayer(playerId);
        for (const meldPileId of meldPiles) {
          const pileSize = state.piles[meldPileId]?.size ?? 0;
          if (pileSize === 0) {
            const candidate: ClientIntent = {
              type: "move",
              gameId,
              playerId,
              fromPileId: playerHandPileId,
              toPileId: meldPileId,
              cardIds,
            };
            if (this.validate(state, candidate).valid) {
              intents.push(candidate);
              // Track cards covered by this multi-card meld
              for (const id of cardIds) {
                cardsCoveredByMultiMeld.add(id);
              }
            }
            break; // Only add to first empty meld pile
          }
        }
      }

      // Keep single-card discards (always needed)
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

      // Single-card melds for extending existing melds only
      // Skip cards already covered by multi-card meld candidates (reduces AI noise)
      for (const card of handCards) {
        if (cardsCoveredByMultiMeld.has(card.id)) continue;
        for (const meldPileId of meldPileIdsForPlayer(playerId)) {
          const existingMeldSize = state.piles[meldPileId]?.size ?? 0;
          // Only allow single-card additions to existing melds with 3+ cards
          if (existingMeldSize < 3) continue;
          const candidate: ClientIntent = {
            type: "move",
            gameId,
            playerId,
            fromPileId: playerHandPileId,
            toPileId: meldPileId,
            cardId: card.id,
          };
          if (this.validate(state, candidate).valid) {
            intents.push(candidate);
          }
        }
      }

      // Allow taking cards back from melds, but only if remaining cards form valid meld
      for (const meldPileId of meldPileIdsForPlayer(playerId)) {
        const meldCards = cardsInPile(state, meldPileId);
        for (const card of meldCards) {
          // Check if remaining cards would still form a valid meld (3+ cards)
          const remainingCards = meldCards.filter((c) => c.id !== card.id);
          if (remainingCards.length > 0 && remainingCards.length < 3) {
            // Would leave invalid meld, skip this candidate
            continue;
          }
          const candidate: ClientIntent = {
            type: "move",
            gameId,
            playerId,
            fromPileId: meldPileId,
            toPileId: playerHandPileId,
            cardId: card.id,
          };
          if (this.validate(state, candidate).valid) {
            intents.push(candidate);
          }
        }
      }

      for (const fromMeld of meldPileIdsForPlayer(playerId)) {
        const fromCards = cardsInPile(state, fromMeld);
        for (const card of fromCards) {
          for (const toMeld of meldPileIdsForPlayer(playerId)) {
            if (fromMeld === toMeld) continue;
            // Skip single-card moves to empty meld piles (prevents breaking up melds)
            const toMeldCards = cardsInPile(state, toMeld);
            if (toMeldCards.length === 0) continue;
            const candidate: ClientIntent = {
              type: "move",
              gameId,
              playerId,
              fromPileId: fromMeld,
              toPileId: toMeld,
              cardId: card.id,
            };
            if (this.validate(state, candidate).valid) {
              intents.push(candidate);
            }
          }
        }
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

      // Reset all hand visibilities to owner-only for the next deal
      for (const player of players) {
        engineEvents.push({
          type: "set-pile-visibility",
          pileId: `${player}-hand`,
          visibility: "owner",
        });
      }

      const shuffledCardIds = shuffleAllCards(state, nextDealNumber, "GIN");

      // Add hand start to recap (keeps previous hand summaries)
      const handStartMsg = `Hand ${nextDealNumber} started (dealer: ${dealer}).`;
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
        layoffCardIds: [],
        result: null,
        recap: [...rulesState.recap, handStartMsg],
      };

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
        if (intent.action === "pass") {
          const dealer = rulesState.dealer;
          nextRulesState = { ...nextRulesState, phase: "first-upcard-dealer" };
          engineEvents.push({ type: "set-current-player", player: dealer });
        } else
          return {
            valid: false,
            reason: getPhaseGuidance(rulesState.phase, rulesState.turnPhase),
            engineEvents: [],
          };
      } else if (rulesState.phase === "first-upcard-dealer") {
        if (intent.action === "pass") {
          const nonDealer = getOtherPlayer(rulesState.dealer, players);
          nextRulesState = {
            ...nextRulesState,
            phase: "playing",
            turnPhase: "must-draw",
          };
          engineEvents.push({ type: "set-current-player", player: nonDealer });
        } else
          return {
            valid: false,
            reason: getPhaseGuidance(rulesState.phase, rulesState.turnPhase),
            engineEvents: [],
          };
      } else if (rulesState.phase === "layoff") {
        if (intent.action !== "finish") {
          return {
            valid: false,
            reason: getPhaseGuidance(rulesState.phase, rulesState.turnPhase),
            engineEvents: [],
          };
        }
        if (!rulesState.knockPlayer || rulesState.knockType !== "knock") {
          return {
            valid: false,
            reason: "Layoff is not active.",
            engineEvents: [],
          };
        }
        const defender = getOtherPlayer(rulesState.knockPlayer, players);

        engineEvents.push({
          type: "announce",
          text: `${defender} finishes layoff`,
          anchor: { type: "screen" },
        });

        for (const meldPileId of meldPileIdsForPlayer(defender)) {
          const meldCards = cardsInPile(state, meldPileId);
          if (meldCards.length === 0) continue;
          const meldError = validateMeld(meldCards);
          if (meldError) {
            return {
              valid: false,
              reason: `Invalid meld in ${meldPileId}. ${meldError}`,
              engineEvents: [],
            };
          }
        }
        nextRulesState = finalizeHand(state, nextRulesState, engineEvents);
      } else {
        return {
          valid: false,
          reason: "Action not allowed now.",
          engineEvents: [],
        };
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
        rulesState.phase !== "first-upcard-dealer" &&
        rulesState.phase !== "layoff"
      ) {
        return {
          valid: false,
          reason: "Hand is not in play.",
          engineEvents: [],
        };
      }

      const from = intent.fromPileId;
      const to = intent.toPileId;

      const fromPile = state.piles[from];
      // Engine guarantees fromPile exists and card is in source pile
      const movedCard = fromPile.cards!.find((c) => c.id === intent.cardId)!;

      if (rulesState.phase === "layoff") {
        if (!rulesState.knockPlayer || rulesState.knockType !== "knock") {
          return {
            valid: false,
            reason: "Layoff is not active.",
            engineEvents: [],
          };
        }
        const knocker = rulesState.knockPlayer;
        const defender = getOtherPlayer(knocker, players);
        if (currentPlayer !== defender) {
          return {
            valid: false,
            reason: "Only the defender may lay off cards.",
            engineEvents: [],
          };
        }

        const handPileId = `${defender}-hand`;
        if (from === handPileId && isPlayerMeldPile(to, knocker)) {
          const meldCards = cardsInPile(state, to);
          const meldError = validateMeld(meldCards);
          if (meldError) {
            return {
              valid: false,
              reason: `Cannot lay off to invalid meld. ${meldError}`,
              engineEvents: [],
            };
          }
          if (!canLayOffToMeld(movedCard, meldCards)) {
            return {
              valid: false,
              reason: "Card cannot be laid off to that meld.",
              engineEvents: [],
            };
          }
          engineEvents.push({
            type: "move-cards",
            fromPileId: handPileId,
            toPileId: to,
            cardIds: [intent.cardId!],
          });
          nextRulesState = {
            ...nextRulesState,
            layoffCardIds: [...nextRulesState.layoffCardIds, intent.cardId!],
          };
        } else if (from === handPileId && isPlayerMeldPile(to, defender)) {
          const meldCards = cardsInPile(state, to);

          // Support both single-card and multi-card melds during layoff
          const cardIds =
            intent.cardId !== undefined ? [intent.cardId] : intent.cardIds!;

          // For multi-card melds to empty pile, validate as complete group
          if (cardIds.length >= 3 && meldCards.length === 0) {
            const movingCards = cardIds
              .map((id) => fromPile?.cards?.find((c) => c.id === id))
              .filter((c): c is SimpleCard => !!c);

            if (movingCards.length !== cardIds.length) {
              return {
                valid: false,
                reason: "One or more cards not in source pile.",
                engineEvents: [],
              };
            }

            // Validate the group forms a valid meld
            const meldError = validateMeld(movingCards);
            if (meldError) {
              return {
                valid: false,
                reason: `Invalid meld: ${meldError}`,
                engineEvents: [],
              };
            }

            // Check for duplicate rank meld
            const firstCard = movingCards[0];
            if (hasExistingSetMeld(state, defender, firstCard.rank)) {
              return {
                valid: false,
                reason:
                  "You already have a meld of that rank. Add to the existing meld instead.",
                engineEvents: [],
              };
            }

            engineEvents.push({
              type: "move-cards",
              fromPileId: handPileId,
              toPileId: to,
              cardIds: cardIds as [number, ...number[]],
            });
          } else {
            // Single card or extending existing meld
            // Prevent single-card melds to empty piles
            if (meldCards.length === 0) {
              return {
                valid: false,
                reason:
                  "You must create melds with at least 3 cards. Use multi-card selection to create a new meld.",
                engineEvents: [],
              };
            }

            if (
              movedCard &&
              hasExistingSetMeld(state, defender, movedCard.rank)
            ) {
              return {
                valid: false,
                reason:
                  "You already have a meld of that rank. Add to the existing meld instead.",
                engineEvents: [],
              };
            }
            if (movedCard && !canAddToMeld(meldCards, movedCard)) {
              return {
                valid: false,
                reason: "Card does not fit that meld.",
                engineEvents: [],
              };
            }
            engineEvents.push({
              type: "move-cards",
              fromPileId: handPileId,
              toPileId: to,
              cardIds: [intent.cardId!],
            });
          }
        } else if (isPlayerMeldPile(from, defender) && to === handPileId) {
          // Validate that remaining cards still form a valid meld (3+ cards)
          const meldCards = cardsInPile(state, from);
          const remainingCards = meldCards.filter(
            (c) => c.id !== intent.cardId
          );
          if (remainingCards.length > 0 && remainingCards.length < 3) {
            return {
              valid: false,
              reason:
                "Cannot remove card from meld. Melds must have at least 3 cards.",
              engineEvents: [],
            };
          }
          // Also validate that remaining cards still form a valid meld pattern
          if (remainingCards.length >= 3) {
            const meldError = validateMeld(remainingCards);
            if (meldError) {
              return {
                valid: false,
                reason: `Cannot remove card. Remaining cards would not form a valid meld: ${meldError}`,
                engineEvents: [],
              };
            }
          }
          engineEvents.push({
            type: "move-cards",
            fromPileId: from,
            toPileId: handPileId,
            cardIds: [intent.cardId!],
          });
        } else if (
          isPlayerMeldPile(from, defender) &&
          isPlayerMeldPile(to, defender)
        ) {
          const meldCards = cardsInPile(state, to);
          // Prevent single-card moves to empty meld piles (prevents breaking up melds)
          if (meldCards.length === 0) {
            return {
              valid: false,
              reason:
                "Cannot move single card to empty meld pile. Take the card back to your hand first.",
              engineEvents: [],
            };
          }
          if (!canAddToMeld(meldCards, movedCard!)) {
            return {
              valid: false,
              reason: "Card does not fit that meld.",
              engineEvents: [],
            };
          }
          engineEvents.push({
            type: "move-cards",
            fromPileId: from,
            toPileId: to,
            cardIds: [intent.cardId!],
          });
        } else if (isPlayerMeldPile(from, knocker) && to === handPileId) {
          if (!rulesState.layoffCardIds.includes(intent.cardId!)) {
            return {
              valid: false,
              reason: "You can only take back cards you laid off.",
              engineEvents: [],
            };
          }
          engineEvents.push({
            type: "move-cards",
            fromPileId: from,
            toPileId: handPileId,
            cardIds: [intent.cardId!],
          });
          nextRulesState = {
            ...nextRulesState,
            layoffCardIds: nextRulesState.layoffCardIds.filter(
              (id) => id !== intent.cardId!
            ),
          };
        } else {
          return {
            valid: false,
            reason:
              "Arrange your melds or lay off from your hand to the knocker's melds.",
            engineEvents: [],
          };
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
            lastDrawnCardId: null, // Clear - can discard any card after drawing from deck
          };
        } else if (from === "discard") {
          const tookUpcard =
            rulesState.phase === "first-upcard-non-dealer" ||
            rulesState.phase === "first-upcard-dealer";
          if (
            rulesState.phase === "playing" &&
            rulesState.lastDrawSource === null
          )
            return {
              valid: false,
              reason: "You must draw from the deck after both players pass.",
              engineEvents: [],
            };
          // Track which card was drawn from discard (can't discard it this turn)
          const discardPile = state.piles["discard"];
          const drawnCardId =
            discardPile?.cards?.[discardPile.cards.length - 1]?.id ?? null;
          engineEvents.push(...drawFromDiscard(state, currentPlayer));
          nextRulesState = {
            ...nextRulesState,
            phase: tookUpcard ? "playing" : nextRulesState.phase,
            turnPhase: "must-discard",
            lastDrawSource: "discard",
            lastDrawnCardId: drawnCardId,
          };
        } else
          return {
            valid: false,
            reason: "Invalid draw source.",
            engineEvents: [],
          };
      } else {
        const handPileId = `${currentPlayer}-hand`;
        if (from === handPileId && isPlayerMeldPile(to, currentPlayer)) {
          // Support both single-card and multi-card melds
          const cardIds =
            intent.cardId !== undefined ? [intent.cardId] : intent.cardIds!;

          const hasMeldCards = meldPileIdsForPlayer(currentPlayer).some(
            (pileId) => (state.piles[pileId]?.size ?? 0) > 0
          );
          if (!hasMeldCards) {
            const handCards = cardsInPile(state, handPileId);
            const minDeadwood = minDeadwoodAfterDiscard(handCards);
            if (minDeadwood > MAX_KNOCK_DEADWOOD) {
              return {
                valid: false,
                reason: "You can only lay down melds when you can knock.",
                engineEvents: [],
              };
            }
          }

          const meldCards = cardsInPile(state, to);

          // For multi-card melds, validate as a complete group
          if (cardIds.length >= 3 && meldCards.length === 0) {
            const movingCards = cardIds
              .map((id) => fromPile?.cards?.find((c) => c.id === id))
              .filter((c): c is SimpleCard => !!c);

            if (movingCards.length !== cardIds.length) {
              return {
                valid: false,
                reason: "One or more cards not in source pile.",
                engineEvents: [],
              };
            }

            // Validate the group forms a valid meld
            const meldError = validateMeld(movingCards);
            if (meldError) {
              return {
                valid: false,
                reason: `Invalid meld: ${meldError}`,
                engineEvents: [],
              };
            }

            // Check for duplicate rank meld
            const firstCard = movingCards[0];
            if (hasExistingSetMeld(state, currentPlayer, firstCard.rank)) {
              return {
                valid: false,
                reason:
                  "You already have a meld of that rank. Add to the existing meld instead.",
                engineEvents: [],
              };
            }

            engineEvents.push({
              type: "move-cards",
              fromPileId: handPileId,
              toPileId: to,
              cardIds: cardIds as [number, ...number[]],
            });
          } else {
            // Single card or extending existing meld
            // Engine guarantees movedCard exists (validated earlier in this function)

            // Prevent single-card melds to empty piles
            if (meldCards.length === 0) {
              return {
                valid: false,
                reason:
                  "You must create melds with at least 3 cards. Use multi-card selection to create a new meld.",
                engineEvents: [],
              };
            }

            if (hasExistingSetMeld(state, currentPlayer, movedCard.rank)) {
              return {
                valid: false,
                reason:
                  "You already have a meld of that rank. Add to the existing meld instead.",
                engineEvents: [],
              };
            }
            if (!canAddToMeld(meldCards, movedCard)) {
              return {
                valid: false,
                reason: "Card does not fit that meld.",
                engineEvents: [],
              };
            }
            engineEvents.push({
              type: "move-cards",
              fromPileId: handPileId,
              toPileId: to,
              cardIds: [intent.cardId!],
            });
          }
        } else if (isPlayerMeldPile(from, currentPlayer) && to === handPileId) {
          // Validate that remaining cards still form a valid meld (3+ cards)
          const meldCards = cardsInPile(state, from);
          const remainingCards = meldCards.filter(
            (c) => c.id !== intent.cardId
          );
          if (remainingCards.length > 0 && remainingCards.length < 3) {
            return {
              valid: false,
              reason:
                "Cannot remove card from meld. Melds must have at least 3 cards.",
              engineEvents: [],
            };
          }
          // Also validate that remaining cards still form a valid meld pattern
          if (remainingCards.length >= 3) {
            const meldError = validateMeld(remainingCards);
            if (meldError) {
              return {
                valid: false,
                reason: `Cannot remove card. Remaining cards would not form a valid meld: ${meldError}`,
                engineEvents: [],
              };
            }
          }
          engineEvents.push({
            type: "move-cards",
            fromPileId: from,
            toPileId: handPileId,
            cardIds: [intent.cardId!],
          });
        } else if (
          isPlayerMeldPile(from, currentPlayer) &&
          isPlayerMeldPile(to, currentPlayer)
        ) {
          const meldCards = cardsInPile(state, to);
          // Prevent single-card moves to empty meld piles (prevents breaking up melds)
          if (meldCards.length === 0) {
            return {
              valid: false,
              reason:
                "Cannot move single card to empty meld pile. Take the card back to your hand first.",
              engineEvents: [],
            };
          }
          if (!canAddToMeld(meldCards, movedCard!)) {
            return {
              valid: false,
              reason: "Card does not fit that meld.",
              engineEvents: [],
            };
          }
          engineEvents.push({
            type: "move-cards",
            fromPileId: from,
            toPileId: to,
            cardIds: [intent.cardId!],
          });
        } else if (from === handPileId && to === "discard") {
          // Cannot discard the card just drawn from discard pile
          if (
            rulesState.lastDrawSource === "discard" &&
            rulesState.lastDrawnCardId !== null &&
            intent.cardId === rulesState.lastDrawnCardId
          ) {
            return {
              valid: false,
              reason:
                "You cannot discard the card you just drew from the discard pile.",
              engineEvents: [],
            };
          }
          engineEvents.push({
            type: "move-cards",
            fromPileId: handPileId,
            toPileId: "discard",
            cardIds: [intent.cardId!],
          });

          // Store turn digest for AI recap
          const turnDigest = formatTurnDigest(
            currentPlayer,
            rulesState,
            movedCard
          );

          const projected = projectPilesAfterEvents(state, engineEvents);
          const meldInfo = collectMeldInfo(projected, currentPlayer);
          if (meldInfo.meldCards.length > 0) {
            if (meldInfo.invalidReason) {
              return {
                valid: false,
                reason: meldInfo.invalidReason,
                engineEvents: [],
              };
            }
            const handAfter = projected[handPileId]?.cards ?? [];
            const deadwoodTotal = handAfter.reduce(
              (sum, c) => sum + deadwoodValue(c.rank),
              0
            );
            let knockType: "knock" | "gin";
            if (deadwoodTotal === 0) {
              knockType = "gin";
            } else if (deadwoodTotal <= MAX_KNOCK_DEADWOOD) {
              knockType = "knock";
            } else {
              return {
                valid: false,
                reason: `You need ${MAX_KNOCK_DEADWOOD} or fewer deadwood to knock.`,
                engineEvents: [],
              };
            }

            // Include turn digest in recap before knock/gin
            const baseKnockState: GinRulesState = {
              ...nextRulesState,
              knockType,
              knockPlayer: currentPlayer,
              lastDrawnCardId: null, // Reset after discard
              recap: [...rulesState.recap, turnDigest],
            };

            engineEvents.push({
              type: "announce",
              text:
                knockType === "gin"
                  ? `${currentPlayer} goes Gin!`
                  : `${currentPlayer} knocks`,
              anchor: { type: "screen" },
            });

            if (knockType === "gin") {
              nextRulesState = finalizeHand(
                state,
                baseKnockState,
                engineEvents
              );
            } else {
              const defender = getOtherPlayer(currentPlayer, players);
              nextRulesState = {
                ...baseKnockState,
                phase: "layoff",
                layoffCardIds: [],
              };
              engineEvents.push({
                type: "set-current-player",
                player: defender,
              });
            }
          } else if (projected["deck"].size <= 2) {
            const blockedSummary = `Hand ${rulesState.dealNumber}: Blocked (deck empty). No points scored.`;
            nextRulesState = {
              ...nextRulesState,
              phase: "ended",
              hasDealt: false,
              knockType: "blocked",
              lastDrawnCardId: null, // Reset after discard
              layoffCardIds: [],
              recap: [blockedSummary], // Collapse recap to hand summary
            };
            nextRulesState.result = `Hand ${rulesState.dealNumber} Result: Blocked (deck empty). No points scored.`;
            engineEvents.push({ type: "set-current-player", player: null });
          } else {
            // Normal turn - append turn digest to recap
            nextRulesState = {
              ...nextRulesState,
              turnPhase: "must-draw",
              lastDrawnCardId: null, // Reset for next turn
              recap: [...rulesState.recap, turnDigest],
            };
            engineEvents.push({
              type: "set-current-player",
              player: getOtherPlayer(currentPlayer, players),
            });
          }
        } else {
          return {
            valid: false,
            reason:
              "Discard from hand or arrange melds before ending your turn.",
            engineEvents: [],
          };
        }
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

    return {
      valid: false,
      reason: getPhaseGuidance(rulesState.phase, rulesState.turnPhase),
      engineEvents: [],
    };
  },
};

export const ginPlugin: GamePlugin = {
  id: "gin-rummy",
  gameName: META.gameName,
  ruleModule: ginRules,
  description: META.description,
  validationHints: {
    sharedPileIds: ["deck", "discard"],
    isPileAlwaysVisibleToRules: (pileId) =>
      pileId.endsWith("-hand") || pileId.includes("-meld-"),
  },
  aiSupport: {
    buildContext: (view: AiView): AiContext => {
      const rulesState = getGinRulesState(
        (view.public as { rulesState?: unknown }).rulesState,
        ["P1", "P2"]
      );

      // Get top card of discard pile (this is what human players see)
      const publicView = view.public as {
        piles?: Array<{
          id: string;
          cards?: Array<{ rank?: string; suit?: string }>;
        }>;
      };
      const discardPile = publicView.piles?.find((p) => p.id === "discard");
      const discardCards = discardPile?.cards ?? [];
      const topDiscardCard =
        discardCards.length > 0 ? discardCards[discardCards.length - 1] : null;

      // Basic facts from game state (no strategy, just state reflection)
      const facts: Record<string, unknown> = {
        phase: rulesState.phase,
        turnPhase: rulesState.turnPhase,
        dealNumber: rulesState.dealNumber,
        matchScores: rulesState.matchScores,
        // Show only the top discard card (what humans see on screen)
        topDiscardCard: topDiscardCard
          ? `${topDiscardCard.rank ?? "?"}${topDiscardCard.suit === "spades" ? "♠" : topDiscardCard.suit === "hearts" ? "♥" : topDiscardCard.suit === "diamonds" ? "♦" : topDiscardCard.suit === "clubs" ? "♣" : "?"}`
          : null,
      };

      // Add knock-related info if relevant
      if (rulesState.knockPlayer) {
        facts.knockPlayer = rulesState.knockPlayer;
        facts.knockType = rulesState.knockType;
      }

      return {
        recap: rulesState.recap.length > 0 ? rulesState.recap : undefined,
        facts,
      };
    },
  },
};
