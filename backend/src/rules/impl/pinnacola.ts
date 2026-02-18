import type { GameRuleModule, GamePlugin } from "../interface.js";
import type { ValidationState } from "../../validation-state.js";
import type {
  ClientIntent,
  ScoreboardCell,
} from "../../../../shared/schemas.js";
import {
  EngineEvent,
  ValidationResult,
} from "../../../../shared/validation.js";
import { loadGameMeta } from "../meta.js";
import { formatCard } from "../../util/card-notation.js";
import { projectPilesAfterEvents, type ProjectedPiles } from "../util/piles.js";
import {
  gatherAllCards,
  shuffleAllCards,
  distributeRoundRobin,
} from "../util/dealing.js";

const META = loadGameMeta("pinnacola");

// Team structure following Canasta pattern
type Team = "A" | "B";
type PinnacolaPhase = "dealing" | "playing" | "ended";
type TurnPhase =
  | "must-draw"
  | "play-or-discard"
  | "must-meld-deepest"
  | "must-reuse-joker";

const PLAYERS = ["S", "N", "W", "E"] as const;

function teamFor(playerId: string): Team {
  return playerId === "S" || playerId === "N" ? "A" : "B";
}

function getOtherPlayer(current: string): string {
  const idx = PLAYERS.indexOf(current as (typeof PLAYERS)[number]);
  return PLAYERS[(idx + 1) % PLAYERS.length];
}

function getTurnPhaseGuidance(turnPhase: TurnPhase): string {
  switch (turnPhase) {
    case "must-draw":
      return "You must draw a card from the deck or take from the discard pile.";
    case "play-or-discard":
      return "You may play cards to your team's melds. When ready, discard a card to end your turn.";
    case "must-meld-deepest":
      return "You took from the discard—now you must meld the deepest card you took.";
    case "must-reuse-joker":
      return "You replaced a joker—now you must use that joker in another meld immediately.";
  }
}

interface PinnacolaRulesState {
  phase: PinnacolaPhase;
  hasDealt: boolean;
  dealNumber: number;
  turnPhase: TurnPhase;
  turnPlayerId: string;
  cardsPlayedToMeldsThisTurn: number[];
  mandatoryMeldCardId: number | null;
  teamScores: Record<Team, number>;
  playersWhoDiscarded: string[];
  result: string | null;
  aiPlayerIds: string[];
}

type SimpleCard = { id: number; rank: string; suit: string };

// Card values per the new rules
const CARD_VALUES: Record<string, number> = {
  JOKER: 30,
  A: 15,
  K: 10,
  Q: 10,
  J: 10,
  "10": 10,
  "9": 10,
  "8": 10,
  "7": 10,
  "6": 10,
  "5": 5,
  "4": 5,
  "3": 5,
  "2": 5, // Natural 2 is 5 pts
};

const BLACK_TWO_WILD_VALUE = 20; // Black two as wild is 20 pts

function isWild(card: SimpleCard): boolean {
  return card.rank === "JOKER" || isBlackTwo(card);
}

function isBlackTwo(card: SimpleCard): boolean {
  return card.rank === "2" && (card.suit === "♠" || card.suit === "♣");
}

function getCardPoints(card: SimpleCard): number {
  if (card.rank === "JOKER") return CARD_VALUES.JOKER;
  if (isBlackTwo(card)) return BLACK_TWO_WILD_VALUE;
  return CARD_VALUES[card.rank] ?? 0;
}

const RANK_TO_NUM: Record<string, number> = {
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

const MELD_SLOT_COUNT = 12;

function getPinnacolaRulesState(
  raw: unknown,
  players: string[]
): PinnacolaRulesState {
  const validPlayers =
    players && players.length === 4 ? players : Array.from(PLAYERS);
  const base: PinnacolaRulesState = {
    phase: "dealing",
    hasDealt: false,
    dealNumber: 0,
    turnPhase: "must-draw",
    turnPlayerId: validPlayers[0],
    cardsPlayedToMeldsThisTurn: [],
    mandatoryMeldCardId: null,
    teamScores: { A: 0, B: 0 },
    playersWhoDiscarded: [],
    result: null,
    aiPlayerIds: [],
  };

  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Partial<PinnacolaRulesState>;
  const teamScores =
    obj.teamScores &&
    typeof obj.teamScores === "object" &&
    !Array.isArray(obj.teamScores)
      ? {
          A:
            typeof (obj.teamScores as Record<string, unknown>).A === "number"
              ? (obj.teamScores as Record<string, number>).A
              : base.teamScores.A,
          B:
            typeof (obj.teamScores as Record<string, unknown>).B === "number"
              ? (obj.teamScores as Record<string, number>).B
              : base.teamScores.B,
        }
      : base.teamScores;
  const cardsPlayedToMeldsThisTurn = Array.isArray(
    obj.cardsPlayedToMeldsThisTurn
  )
    ? obj.cardsPlayedToMeldsThisTurn.filter(
        (id): id is number => typeof id === "number"
      )
    : base.cardsPlayedToMeldsThisTurn;
  const playersWhoDiscarded = Array.isArray(obj.playersWhoDiscarded)
    ? obj.playersWhoDiscarded.filter(
        (playerId): playerId is string => typeof playerId === "string"
      )
    : base.playersWhoDiscarded;
  const aiPlayerIds = Array.isArray(obj.aiPlayerIds)
    ? obj.aiPlayerIds.filter(
        (playerId): playerId is string => typeof playerId === "string"
      )
    : base.aiPlayerIds;

  return {
    ...base,
    ...obj,
    cardsPlayedToMeldsThisTurn,
    playersWhoDiscarded,
    aiPlayerIds,
    teamScores,
  };
}

function meldPileIdsForTeam(team: Team): string[] {
  return Array.from({ length: MELD_SLOT_COUNT }, (_, i) => `${team}-meld-${i}`);
}

interface MeldValidation {
  valid: boolean;
  type?: "set" | "run";
  cardPoints?: number;
  bonusPoints?: number;
  isPinnacola?: boolean; // 7+ clean run
  isPinnacolone?: boolean; // A-K clean run (immediate win)
  isPoker?: boolean; // 4-of-kind natural
  isClean?: boolean; // No wilds
  cardCount?: number;
}

function validateMeld(cards: SimpleCard[]): MeldValidation {
  if (cards.length < 3) return { valid: false };

  const wilds = cards.filter(isWild);
  const naturals = cards.filter((c) => !isWild(c));

  // Can't have all wilds (except special cases)
  if (naturals.length === 0) {
    // Special case: 4 jokers = Poker of Jokers
    if (wilds.every((c) => c.rank === "JOKER") && wilds.length === 4) {
      const cardPoints = wilds.reduce((sum, c) => sum + getCardPoints(c), 0);
      return {
        valid: true,
        type: "set",
        cardPoints,
        bonusPoints: 500,
        isPoker: true,
        isClean: false,
        cardCount: 4,
      };
    }
    return { valid: false };
  }

  const isClean = wilds.length === 0;

  // Try SET (Tris/Poker)
  const firstRank = naturals[0].rank;
  const isSet = naturals.every((c) => c.rank === firstRank);
  if (isSet) {
    const suits = new Set(naturals.map((c) => c.suit));
    if (suits.size !== naturals.length) return { valid: false }; // Must be different suits

    const cardPoints = cards.reduce((sum, c) => sum + getCardPoints(c), 0);
    const isPoker = cards.length === 4 && isClean;
    let bonusPoints = 0;

    if (isPoker) {
      // Poker bonuses
      if (firstRank === "A") bonusPoints = 120;
      else if (["K", "Q", "J", "10", "9", "8", "7", "6"].includes(firstRank))
        bonusPoints = 80;
      else bonusPoints = 40; // 2-5
    }

    return {
      valid: true,
      type: "set",
      cardPoints,
      bonusPoints,
      isPoker,
      isClean,
      cardCount: cards.length,
    };
  }

  // Try RUN (Scala)
  const firstSuit = naturals[0].suit;
  if (!naturals.every((c) => c.suit === firstSuit)) return { valid: false };

  // Check sequence with wilds filling gaps
  const checkSequence = (vals: number[]) => {
    vals.sort((a, b) => a - b);
    let gaps = 0;
    for (let i = 0; i < vals.length - 1; i++) {
      const diff = vals[i + 1] - vals[i];
      if (diff === 0) return { valid: false, gaps: 999 };
      gaps += diff - 1;
    }
    return { valid: gaps <= wilds.length, gaps };
  };

  const lowSeq = checkSequence(naturals.map((c) => RANK_TO_NUM[c.rank]));
  const highSeq = naturals.some((c) => c.rank === "A")
    ? checkSequence(
        naturals.map((c) => (c.rank === "A" ? 14 : RANK_TO_NUM[c.rank]))
      )
    : { valid: false };

  if (lowSeq.valid || highSeq.valid) {
    const cardPoints = cards.reduce((sum, c) => sum + getCardPoints(c), 0);

    // Check for Pinnacolone (A-K complete clean run)
    const isPinnacolone = isClean && cards.length === 13;
    if (isPinnacolone) {
      return {
        valid: true,
        type: "run",
        cardPoints,
        bonusPoints: 1500,
        isPinnacolone: true,
        isClean: true,
        cardCount: 13,
      };
    }

    // Check for Pinnacola (7+ clean run)
    const isPinnacola = isClean && cards.length >= 7;

    return {
      valid: true,
      type: "run",
      cardPoints,
      isPinnacola,
      isClean,
      cardCount: cards.length,
    };
  }

  return { valid: false };
}

function validateMeldOrder(cards: SimpleCard[]): boolean {
  const result = validateMeld(cards);
  if (!result.valid || result.type !== "run") return true;

  const naturals = cards.filter((c) => !isWild(c));
  if (naturals.length <= 1) return true;

  const hasAce = naturals.some((c) => c.rank === "A");

  const checkOrder = (aceHigh: boolean): boolean => {
    const minValue = aceHigh ? 2 : 1;
    const maxValue = aceHigh ? 14 : 13;
    let startValue: number | null = null;

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (isWild(card)) continue;
      const value = card.rank === "A" && aceHigh ? 14 : RANK_TO_NUM[card.rank];
      const candidateStart = value - i;
      if (startValue === null) {
        startValue = candidateStart;
      } else if (candidateStart !== startValue) {
        return false;
      }
    }

    if (startValue === null) {
      return minValue <= maxValue - (cards.length - 1);
    }

    return (
      startValue >= minValue && startValue + (cards.length - 1) <= maxValue
    );
  };

  return hasAce ? checkOrder(false) || checkOrder(true) : checkOrder(false);
}

function formatMeldLabel(pileId: string): string {
  const match = pileId.match(/^(A|B)-meld-(\d+)$/);
  if (!match) return pileId;
  const index = Number(match[2]);
  return `Meld ${match[1]}${index + 1}`;
}

function describeMeldIssue(
  cards: SimpleCard[],
  options?: { skipOrderCheck?: boolean }
): string | null {
  if (cards.length < 3) return "Meld must have at least 3 cards.";

  const validation = validateMeld(cards);
  if (!validation.valid) {
    const naturals = cards.filter((c) => !isWild(c));
    if (naturals.length === 0) return "Meld cannot be all wild cards.";

    const ranks = new Set(naturals.map((c) => c.rank));
    const suits = new Set(naturals.map((c) => c.suit));
    const sameRank = ranks.size === 1;
    const sameSuit = suits.size === 1;

    if (sameRank) {
      if (suits.size !== naturals.length) return "Set has duplicate suits.";
      return "Set is invalid.";
    }
    if (sameSuit) {
      if (ranks.size !== naturals.length) return "Run has duplicate ranks.";
      return "Run is invalid.";
    }

    return "Meld must be all same rank (set) or same suit in sequence (run).";
  }

  // Skip order check when requested (e.g., for AI validation where order is handled automatically)
  if (!options?.skipOrderCheck && !validateMeldOrder(cards)) {
    return "Run is out of order. Arrange cards in ascending order with wilds filling the gaps.";
  }

  return null;
}

function isPotentialSet(cards: SimpleCard[]): boolean {
  const naturals = cards.filter((c) => !isWild(c));
  if (naturals.length === 0) return true;

  const rank = naturals[0].rank;
  if (!naturals.every((c) => c.rank === rank)) return false;

  const suits = new Set(naturals.map((c) => c.suit));
  return suits.size === naturals.length;
}

function isPotentialRun(cards: SimpleCard[]): boolean {
  const naturals = cards.filter((c) => !isWild(c));
  if (naturals.length === 0) return true;

  const suit = naturals[0].suit;
  if (!naturals.every((c) => c.suit === suit)) return false;

  const ranks = new Set(naturals.map((c) => c.rank));
  return ranks.size === naturals.length;
}

function isPotentialMeld(cards: SimpleCard[]): boolean {
  return isPotentialSet(cards) || isPotentialRun(cards);
}

/**
 * Compute the correct insertion index for adding a card to an existing run.
 * Returns undefined if the meld is a set or if the card doesn't fit the run.
 */
function computeRunInsertIndex(
  existingCards: SimpleCard[],
  newCard: SimpleCard
): number | undefined {
  if (existingCards.length < 3) return undefined;

  const validation = validateMeld(existingCards);
  if (!validation.valid || validation.type !== "run") return undefined;

  // For runs, find where the new card should be inserted based on rank
  const naturals = existingCards.filter((c) => !isWild(c));
  if (naturals.length === 0) return undefined;

  const suit = naturals[0].suit;

  // If the new card is a wild, append at the end (wilds are flexible)
  if (isWild(newCard)) return existingCards.length;

  // If the new card doesn't match the suit, it's not valid for this run
  if (newCard.suit !== suit) return undefined;

  const newRankNum = RANK_TO_NUM[newCard.rank] ?? 0;

  // Find all rank numbers in the run (including wilds as gaps)
  // We need to determine the range of the run
  const naturalRanks = naturals
    .map((c) => RANK_TO_NUM[c.rank] ?? 0)
    .sort((a, b) => a - b);
  const minRank = naturalRanks[0];
  const maxRank = naturalRanks[naturalRanks.length - 1];

  // Check if new card extends at the start
  if (newRankNum === minRank - 1 || (minRank > 1 && newRankNum < minRank)) {
    return 0;
  }

  // Check if new card extends at the end
  if (newRankNum === maxRank + 1 || newRankNum > maxRank) {
    return existingCards.length;
  }

  // Card fits somewhere in the middle (shouldn't happen with valid additions)
  return existingCards.length;
}

/**
 * Generate all viable multi-card meld candidates from a hand.
 * Returns arrays of card IDs that form valid sets or runs.
 *
 * Rules:
 * - Set (Tris): 3 cards of same rank with different suits
 * - Run (Scala): 3+ consecutive cards of same suit
 * - Wilds (Jokers and black twos) can substitute for any card
 */
function generatePinnacolaMeldCandidates(hand: SimpleCard[]): number[][] {
  if (hand.length < 3) return [];

  const melds: number[][] = [];
  const wilds = hand.filter(isWild);
  const naturals = hand.filter((c) => !isWild(c));

  // SETS (Tris): 3 cards of same rank, different suits
  const byRank = new Map<string, SimpleCard[]>();
  for (const card of naturals) {
    if (!byRank.has(card.rank)) byRank.set(card.rank, []);
    byRank.get(card.rank)!.push(card);
  }

  for (const cards of byRank.values()) {
    // Pure natural sets (3 different suits)
    if (cards.length >= 3) {
      for (let i = 0; i < cards.length; i++) {
        for (let j = i + 1; j < cards.length; j++) {
          for (let k = j + 1; k < cards.length; k++) {
            const triple = [cards[i], cards[j], cards[k]];
            const suits = new Set(triple.map((c) => c.suit));
            if (suits.size === 3) {
              melds.push(triple.map((c) => c.id));
            }
          }
        }
      }
    }

    // Sets with 2 naturals + 1 wild (different suits)
    if (cards.length >= 2 && wilds.length >= 1) {
      for (let i = 0; i < cards.length; i++) {
        for (let j = i + 1; j < cards.length; j++) {
          if (cards[i].suit !== cards[j].suit) {
            melds.push([cards[i].id, cards[j].id, wilds[0].id]);
          }
        }
      }
    }
  }

  // RUNS (Scala): 3+ consecutive same suit
  const bySuit = new Map<string, SimpleCard[]>();
  for (const card of naturals) {
    if (!bySuit.has(card.suit)) bySuit.set(card.suit, []);
    bySuit.get(card.suit)!.push(card);
  }

  for (const suitCards of bySuit.values()) {
    // Sort by rank
    const sorted = suitCards
      .map((c) => ({ card: c, rankNum: RANK_TO_NUM[c.rank] ?? 0 }))
      .sort((a, b) => a.rankNum - b.rankNum);

    // Find all consecutive sequences of 3+ (pure naturals)
    let start = 0;
    while (start < sorted.length) {
      let end = start;
      while (
        end + 1 < sorted.length &&
        sorted[end + 1].rankNum === sorted[end].rankNum + 1
      ) {
        end++;
      }

      const runLength = end - start + 1;
      if (runLength >= 3) {
        // Generate all sub-runs of length 3 to runLength
        for (let len = 3; len <= runLength; len++) {
          for (let i = start; i <= end - len + 1; i++) {
            const runCards = sorted
              .slice(i, i + len)
              .map((item) => item.card.id);
            melds.push(runCards);
          }
        }
      }

      start = end + 1;
    }

    // Runs with wilds filling gaps (only minimal 3-card runs)
    if (wilds.length >= 1 && sorted.length >= 2) {
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const gap = sorted[j].rankNum - sorted[i].rankNum;
          // Gap of 2: one card missing between, fill with wild
          if (gap === 2) {
            melds.push([sorted[i].card.id, wilds[0].id, sorted[j].card.id]);
          }
          // Gap of 1: consecutive pair, add wild at start or end
          if (gap === 1) {
            const startRank = sorted[i].rankNum;
            const endRank = sorted[j].rankNum;
            // Wild at start (if rank allows, Ace is 1)
            if (startRank > 1) {
              melds.push([wilds[0].id, sorted[i].card.id, sorted[j].card.id]);
            }
            // Wild at end (if rank allows, King is 13)
            if (endRank < 13) {
              melds.push([sorted[i].card.id, sorted[j].card.id, wilds[0].id]);
            }
          }
        }
      }
    }
  }

  // Special case: Poker of Jokers (4 jokers)
  if (wilds.filter((c) => c.rank === "JOKER").length === 4) {
    melds.push(wilds.filter((c) => c.rank === "JOKER").map((c) => c.id));
  }

  return melds;
}

function calculateScores(projected: ProjectedPiles): {
  scores: Record<Team, number>;
  hasCleanPinnacola: Record<Team, boolean>;
  pinnacoloneTeams: Team[];
} {
  const scores: Record<Team, number> = { A: 0, B: 0 };
  const hasCleanPinnacola: Record<Team, boolean> = { A: false, B: false };
  const pinnacoloneTeams: Team[] = [];

  for (const team of ["A", "B"] as const) {
    // Subtract hand values for both team members
    const teamPlayers = PLAYERS.filter((p) => teamFor(p) === team);
    for (const pid of teamPlayers) {
      const hand = projected[`${pid}-hand`]?.cards ?? [];
      scores[team] -= hand.reduce((sum, c) => sum + getCardPoints(c), 0);
    }

    // Collect meld validation results
    const teamMelds = meldPileIdsForTeam(team)
      .map((id) => projected[id]?.cards)
      .filter((cards): cards is SimpleCard[] => !!cards && cards.length > 0);

    const meldResults = teamMelds.map(validateMeld);

    // Check for Pinnacolone
    if (meldResults.some((v) => v.isPinnacolone)) {
      pinnacoloneTeams.push(team);
    }

    // Check for clean Pinnacola (7+ run)
    hasCleanPinnacola[team] = meldResults.some((v) => v.isPinnacola);

    // Calculate meld card points and bonuses
    let meldCardPoints = 0;
    let meldBonusPoints = 0;
    for (const v of meldResults) {
      if (v.valid) {
        meldCardPoints += v.cardPoints ?? 0;
        meldBonusPoints += v.bonusPoints ?? 0;
      }
    }

    // Apply multipliers
    const multiplier = hasCleanPinnacola[team] ? 2 : 1;
    scores[team] += meldCardPoints * multiplier + meldBonusPoints;

    // Check for going out bonus
    const anyHandEmpty = teamPlayers.some(
      (pid) => (projected[`${pid}-hand`]?.cards?.length ?? 0) === 0
    );
    if (anyHandEmpty) {
      scores[team] += 100;
    }
  }

  return { scores, hasCleanPinnacola, pinnacoloneTeams };
}

function canMeldDeepestAfterPickup(
  state: ValidationState,
  playerId: string,
  deepestCard: SimpleCard,
  pickedCards: SimpleCard[]
): boolean {
  const myTeam = teamFor(playerId);
  const handCards = state.piles[`${playerId}-hand`]?.cards ?? [];
  const availableCards = [...handCards, ...pickedCards];
  const otherCards = availableCards.filter((c) => c.id !== deepestCard.id);

  // Can add to existing team meld
  for (const mid of meldPileIdsForTeam(myTeam)) {
    const existing = state.piles[mid]?.cards ?? [];
    const newCards = [...existing, deepestCard];
    if (newCards.length >= 3 && validateMeld(newCards).valid) return true;

    // Allow joker replacement with a natural card
    const joker = existing.find((c) => c.rank === "JOKER");
    if (joker && !isWild(deepestCard)) {
      const withoutJoker = existing.filter((c) => c.id !== joker.id);
      const withNatural = [...withoutJoker, deepestCard];
      if (validateMeld(withNatural).valid) return true;
    }
  }

  // Can form a new meld with two other cards
  if (otherCards.length < 2) return false;
  for (let i = 0; i < otherCards.length; i++) {
    for (let j = i + 1; j < otherCards.length; j++) {
      if (validateMeld([deepestCard, otherCards[i], otherCards[j]]).valid) {
        return true;
      }
    }
  }

  return false;
}

function teamHasPinnacolone(projected: ProjectedPiles, team: Team): boolean {
  const teamMelds = meldPileIdsForTeam(team)
    .map((id) => projected[id]?.cards)
    .filter((cards): cards is SimpleCard[] => !!cards && cards.length > 0);

  return teamMelds.some((cards) => validateMeld(cards).isPinnacolone);
}

function recomputeDerived(
  _state: ValidationState,
  rulesState: PinnacolaRulesState,
  engineEvents: EngineEvent[]
): void {
  engineEvents.push({ type: "set-rules-state", rulesState: { ...rulesState } });
}

export const pinnacolaRules: GameRuleModule = {
  listLegalIntentsForPlayer(
    state: ValidationState,
    playerId: string
  ): ClientIntent[] {
    const rs = getPinnacolaRulesState(state.rulesState, Array.from(PLAYERS));
    const intents: ClientIntent[] = [];

    if (rs.phase === "dealing") {
      if (!rs.hasDealt)
        intents.push({
          type: "action",
          gameId: state.gameId,
          playerId,
          action: "start-game",
        });
      return intents;
    }

    if (rs.phase !== "playing" || rs.turnPlayerId !== playerId) return [];

    const hand = state.piles[`${playerId}-hand`]?.cards ?? [];
    const myTeam = teamFor(playerId);
    const myMeldPiles = meldPileIdsForTeam(myTeam);

    if (rs.turnPhase === "must-draw") {
      // Draw from deck
      const deck = state.piles["deck"];
      if (deck?.size && deck.topCard)
        intents.push({
          type: "move",
          gameId: state.gameId,
          playerId,
          fromPileId: "deck",
          toPileId: `${playerId}-hand`,
          cardId: deck.topCard.id,
        });

      // Take from discard (can pick any depth if we can meld the deepest)
      const disc = state.piles["discard"];
      if (disc?.size && disc.cards) {
        for (let i = 0; i < disc.cards.length; i++) {
          const deepest = disc.cards[i];
          const pickedCards = disc.cards.slice(i);
          const canMeld = canMeldDeepestAfterPickup(
            state,
            playerId,
            deepest,
            pickedCards
          );

          if (canMeld) {
            intents.push({
              type: "move",
              gameId: state.gameId,
              playerId,
              fromPileId: "discard",
              toPileId: `${playerId}-hand`,
              cardId: deepest.id,
            });
          }
        }
      }
    } else if (
      rs.turnPhase === "play-or-discard" ||
      rs.turnPhase === "must-meld-deepest" ||
      rs.turnPhase === "must-reuse-joker"
    ) {
      // For AI candidate generation, only require valid melds (not order)
      // Order is a UI concern - human players can reorder, AI just needs valid melds
      const canDiscard = myMeldPiles.every((mid) => {
        const pile = state.piles[mid];
        if (!pile || pile.size === 0) return true;
        if (pile.size < 3) return false;
        if (!pile.cards) return true;
        return validateMeld(pile.cards).valid;
      });

      // Check if this player is AI (stored in rulesState during start-game)
      const isAiPlayer = rs.aiPlayerIds.includes(playerId);

      if (isAiPlayer) {
        // AI PLAYERS: Use multi-card meld candidates only
        // Track cards covered by multi-card meld candidates to avoid redundant single-card options
        const cardsCoveredByMultiMeld = new Set<number>();

        // Generate multi-card meld candidates from full hand
        // For must-meld-deepest or must-reuse-joker, filter to candidates that include mandatory card
        const mustIncludeCardId =
          rs.turnPhase === "must-meld-deepest" ||
          rs.turnPhase === "must-reuse-joker"
            ? rs.mandatoryMeldCardId
            : undefined;

        const allMeldCandidates = generatePinnacolaMeldCandidates(hand);
        const meldCandidates = mustIncludeCardId
          ? allMeldCandidates.filter((cardIds) =>
              cardIds.includes(mustIncludeCardId)
            )
          : allMeldCandidates;
        for (const cardIds of meldCandidates) {
          // Find first empty meld pile for this candidate
          for (const mid of myMeldPiles) {
            const existingSize = state.piles[mid]?.size ?? 0;
            if (existingSize === 0) {
              // Validate the meld
              const meldCards = cardIds
                .map((id) => hand.find((c) => c.id === id))
                .filter((c): c is SimpleCard => !!c);
              if (
                meldCards.length === cardIds.length &&
                validateMeld(meldCards).valid
              ) {
                intents.push({
                  type: "move",
                  gameId: state.gameId,
                  playerId,
                  fromPileId: `${playerId}-hand`,
                  toPileId: mid,
                  cardIds,
                });
                // Track these cards as covered
                for (const id of cardIds) {
                  cardsCoveredByMultiMeld.add(id);
                }
              }
              break; // Only add to first empty pile
            }
          }
        }

        // Single-card additions to existing valid melds (3+ cards)
        // For must-meld-deepest or must-reuse-joker, only consider the mandatory card
        const singleCardCandidates = mustIncludeCardId
          ? hand.filter((c) => c.id === mustIncludeCardId)
          : hand;

        for (const c of singleCardCandidates) {
          // Skip cards already covered by multi-card melds (unless mandatory)
          if (cardsCoveredByMultiMeld.has(c.id) && !mustIncludeCardId) {
            continue;
          }

          for (const mid of myMeldPiles) {
            const targetPile = state.piles[mid];
            const cards = targetPile?.cards ?? [];

            // Joker replacement: natural card replaces a joker in an existing meld
            const joker = cards.find((pc) => pc.rank === "JOKER");
            if (joker && !isWild(c)) {
              const withoutJoker = cards.filter((pc) => pc.id !== joker.id);
              const withNatural = [...withoutJoker, c];
              if (validateMeld(withNatural).valid) {
                intents.push({
                  type: "move",
                  gameId: state.gameId,
                  playerId,
                  fromPileId: `${playerId}-hand`,
                  toPileId: mid,
                  cardId: c.id,
                });
                continue;
              }
            }

            // Only allow single-card additions to existing melds with 3+ cards
            if (cards.length < 3) continue;

            const newCards = [...cards, c];
            if (validateMeld(newCards).valid) {
              intents.push({
                type: "move",
                gameId: state.gameId,
                playerId,
                fromPileId: `${playerId}-hand`,
                toPileId: mid,
                cardId: c.id,
              });
            }
          }
        }
      } else {
        // HUMAN PLAYERS: Single-card moves to any meld pile
        for (const c of hand) {
          for (const mid of myMeldPiles) {
            intents.push({
              type: "move",
              gameId: state.gameId,
              playerId,
              fromPileId: `${playerId}-hand`,
              toPileId: mid,
              cardId: c.id,
            });
          }
        }

        // HUMAN PLAYERS: Unmeld moves (meld pile → hand)
        // Can take back cards played THIS turn (to fix mistakes)
        // Cannot take back cards from previous turns (committed) or black twos (fixed)
        for (const mid of myMeldPiles) {
          const meldCards = state.piles[mid]?.cards ?? [];
          for (const c of meldCards) {
            // Can only unmeld cards played THIS turn
            if (!rs.cardsPlayedToMeldsThisTurn.includes(c.id)) continue;
            // Can't unmeld black twos (they are fixed)
            if (c.rank === "2" && (c.suit === "clubs" || c.suit === "spades"))
              continue;
            intents.push({
              type: "move",
              gameId: state.gameId,
              playerId,
              fromPileId: mid,
              toPileId: `${playerId}-hand`,
              cardId: c.id,
            });
          }
        }

        // HUMAN PLAYERS: Move cards between melds (meld → meld)
        // Can move cards played THIS turn to reorganize melds
        for (const fromMid of myMeldPiles) {
          const meldCards = state.piles[fromMid]?.cards ?? [];
          for (const c of meldCards) {
            // Can only move cards played THIS turn
            if (!rs.cardsPlayedToMeldsThisTurn.includes(c.id)) continue;
            // Can't move black twos (they are fixed)
            if (c.rank === "2" && (c.suit === "clubs" || c.suit === "spades"))
              continue;
            // Offer moves to other meld piles
            for (const toMid of myMeldPiles) {
              if (toMid === fromMid) continue;
              intents.push({
                type: "move",
                gameId: state.gameId,
                playerId,
                fromPileId: fromMid,
                toPileId: toMid,
                cardId: c.id,
              });
            }
          }
        }
      }

      // Discard (only in play-or-discard phase, and only with valid melds)
      if (rs.turnPhase === "play-or-discard" && canDiscard) {
        for (const c of hand) {
          intents.push({
            type: "move",
            gameId: state.gameId,
            playerId,
            fromPileId: `${playerId}-hand`,
            toPileId: "discard",
            cardId: c.id,
          });
        }
      }

      // NOTE: AI is NOT offered unmeld or reorder moves.
      // Human players can still do these via the UI (validate() allows them).
    }

    return intents.filter((intent) => this.validate(state, intent).valid);
  },

  validate(state: ValidationState, intent: ClientIntent): ValidationResult {
    const rs = getPinnacolaRulesState(state.rulesState, Array.from(PLAYERS));
    const nextRS = { ...rs };
    const engineEvents: EngineEvent[] = [];

    if (!rs.hasDealt) {
      if (intent.type === "action" && intent.action === "start-game") {
        const nextDeal = rs.dealNumber + 1;

        engineEvents.push(...gatherAllCards(state));

        // Shuffle all cards
        const shuffled = shuffleAllCards(state, nextDeal, "PINNA");

        // Deal 19 cards each
        const { events: dealEvents, nextIndex } = distributeRoundRobin(
          shuffled,
          PLAYERS.map((p) => `${p}-hand`),
          19
        );
        engineEvents.push(...dealEvents);

        // Flip one card to discard
        engineEvents.push({
          type: "move-cards",
          fromPileId: "deck",
          toPileId: "discard",
          cardIds: [shuffled[nextIndex]],
        });

        // Reset hand visibilities after dealing to preserve deal animation
        for (const player of PLAYERS) {
          engineEvents.push({
            type: "set-pile-visibility",
            pileId: `${player}-hand`,
            visibility: "owner",
          });
        }

        // Set discard pile to horizontal layout and enable reordering on meld piles
        const pileProperties: Record<
          string,
          {
            layout?: "complete" | "horizontal" | "vertical" | "spread";
            allowReorder?: boolean;
          }
        > = {
          discard: { layout: "horizontal" },
        };

        // Enable reordering for all team meld piles
        for (const team of ["A", "B"] as const) {
          for (let i = 0; i < 12; i++) {
            pileProperties[`${team}-meld-${i}`] = { allowReorder: true };
          }
        }

        engineEvents.push({
          type: "set-pile-properties",
          properties: pileProperties,
        });

        nextRS.hasDealt = true;
        nextRS.dealNumber = nextDeal;
        nextRS.phase = "playing";
        nextRS.turnPlayerId = PLAYERS[nextDeal % PLAYERS.length];
        nextRS.turnPhase = "must-draw";
        nextRS.playersWhoDiscarded = [];
        nextRS.aiPlayerIds = state.players
          .filter((p) => p.isAi)
          .map((p) => p.id);

        engineEvents.push({
          type: "set-current-player",
          player: nextRS.turnPlayerId,
        });
        recomputeDerived(state, nextRS, engineEvents);
        return { valid: true, engineEvents };
      }
      return { valid: false, reason: "Start game first.", engineEvents: [] };
    }

    if (intent.playerId !== rs.turnPlayerId)
      return { valid: false, reason: "Not your turn.", engineEvents: [] };

    if (rs.turnPhase === "must-draw") {
      if (
        intent.type === "move" &&
        intent.toPileId === `${intent.playerId}-hand`
      ) {
        const cardId = intent.cardId!;

        if (intent.fromPileId === "deck") {
          engineEvents.push({
            type: "move-cards",
            fromPileId: "deck",
            toPileId: `${intent.playerId}-hand`,
            cardIds: [cardId],
          });
          nextRS.turnPhase = "play-or-discard";
          nextRS.cardsPlayedToMeldsThisTurn = [];
          recomputeDerived(state, nextRS, engineEvents);
          return { valid: true, engineEvents };
        } else if (intent.fromPileId === "discard") {
          const disc = state.piles["discard"];
          const cards = disc.cards!;
          const deepestIndex = cards.findIndex((c) => c.id === cardId);
          if (deepestIndex === -1)
            return {
              valid: false,
              reason: "Card not in discard.",
              engineEvents: [],
            };

          // Take deepest and all cards after it
          const toTake = cards.slice(deepestIndex);
          const deepestCard = cards[deepestIndex];
          if (
            !canMeldDeepestAfterPickup(
              state,
              intent.playerId,
              deepestCard,
              toTake
            )
          ) {
            return {
              valid: false,
              reason:
                "You can only take from the discard if the deepest card can be melded immediately.",
              engineEvents: [],
            };
          }
          engineEvents.push({
            type: "move-cards",
            fromPileId: "discard",
            toPileId: `${intent.playerId}-hand`,
            cardIds: toTake.map((c) => c.id) as [number, ...number[]],
          });
          nextRS.turnPhase = "must-meld-deepest";
          nextRS.mandatoryMeldCardId = cardId;
          nextRS.cardsPlayedToMeldsThisTurn = [];
          recomputeDerived(state, nextRS, engineEvents);
          return { valid: true, engineEvents };
        } else {
          return {
            valid: false,
            reason: "Draw from deck or discard.",
            engineEvents: [],
          };
        }
      }
    }

    if (
      rs.turnPhase === "play-or-discard" ||
      rs.turnPhase === "must-meld-deepest" ||
      rs.turnPhase === "must-reuse-joker"
    ) {
      if (intent.type === "move") {
        const myTeam = teamFor(intent.playerId);
        const isToOwnMeld = intent.toPileId.startsWith(`${myTeam}-meld-`);

        if (isToOwnMeld) {
          // Allow reordering within the same meld
          const isReordering = intent.fromPileId === intent.toPileId;
          const isFromOwnMeld = intent.fromPileId.startsWith(`${myTeam}-meld-`);

          // Allow moving from hand, reordering within same meld, or meld-to-meld
          if (
            !isReordering &&
            !isFromOwnMeld &&
            intent.fromPileId !== `${intent.playerId}-hand`
          ) {
            return {
              valid: false,
              reason: "Can only meld from your hand.",
              engineEvents: [],
            };
          }

          // Meld-to-meld: only cards played this turn, no black twos
          if (isFromOwnMeld && !isReordering) {
            const movingCard = state.allCards[intent.cardId!];
            if (isBlackTwo(movingCard)) {
              return {
                valid: false,
                reason:
                  "Black twos are fixed to their meld and cannot be moved to another meld.",
                engineEvents: [],
              };
            }
            if (!rs.cardsPlayedToMeldsThisTurn.includes(intent.cardId!)) {
              return {
                valid: false,
                reason: "Can only move cards added this turn between melds.",
                engineEvents: [],
              };
            }
          }

          // If reordering, just update the card position
          if (isReordering) {
            // Allow repositioning cards within the same meld
            // This is needed for jokers and black twos
            const targetIndex =
              "targetIndex" in intent ? intent.targetIndex : undefined;
            if (typeof targetIndex !== "number") {
              return {
                valid: false,
                reason: "Reordering requires a target position.",
                engineEvents: [],
              };
            }
            engineEvents.push({
              type: "move-cards",
              fromPileId: intent.fromPileId,
              toPileId: intent.toPileId,
              cardIds: [intent.cardId!],
              targetIndex,
            });
            recomputeDerived(state, nextRS, engineEvents);
            return { valid: true, engineEvents };
          }

          // Handle both single-card and multi-card intents
          const intentCardIds =
            intent.cardId !== undefined ? [intent.cardId] : intent.cardIds!;

          // For mandatory meld, check if the mandatory card is included
          if (rs.mandatoryMeldCardId) {
            if (!intentCardIds.includes(rs.mandatoryMeldCardId)) {
              const mc = state.allCards[rs.mandatoryMeldCardId];
              return {
                valid: false,
                reason: `You must meld ${formatCard(mc.rank, mc.suit)} first.`,
                engineEvents: [],
              };
            }
          }

          const targetPile = state.piles[intent.toPileId];
          const existingCards = targetPile?.cards ?? [];
          const fromPile = state.piles[intent.fromPileId];
          const movingCards = intentCardIds
            .map((id) => fromPile?.cards?.find((c) => c.id === id))
            .filter((c): c is SimpleCard => !!c);

          if (movingCards.length !== intentCardIds.length) {
            return {
              valid: false,
              reason: "One or more cards not in source pile.",
              engineEvents: [],
            };
          }

          // Multi-card meld to empty pile
          if (intentCardIds.length >= 3 && existingCards.length === 0) {
            if (!validateMeld(movingCards).valid) {
              const issue = describeMeldIssue(movingCards, {
                skipOrderCheck: true,
              });
              return {
                valid: false,
                reason: issue ?? "Invalid meld.",
                engineEvents: [],
              };
            }
            engineEvents.push({
              type: "move-cards",
              fromPileId: intent.fromPileId,
              toPileId: intent.toPileId,
              cardIds: intentCardIds as [number, ...number[]],
            });
            nextRS.cardsPlayedToMeldsThisTurn = [
              ...nextRS.cardsPlayedToMeldsThisTurn,
              ...intentCardIds,
            ];
            if (
              rs.turnPhase === "must-meld-deepest" ||
              rs.turnPhase === "must-reuse-joker"
            ) {
              nextRS.turnPhase = "play-or-discard";
              nextRS.mandatoryMeldCardId = null;
            }
            recomputeDerived(state, nextRS, engineEvents);
            return { valid: true, engineEvents };
          }

          // Single-card path (original logic)
          const movingCard = movingCards[0];

          // Check joker replacement
          const joker = existingCards.find((c) => c.rank === "JOKER");
          if (joker && !isWild(movingCard)) {
            const withoutJoker = existingCards.filter((c) => c.id !== joker.id);
            const withNatural = [...withoutJoker, movingCard];
            const v = validateMeld(withNatural);
            if (v.valid) {
              engineEvents.push({
                type: "move-cards",
                fromPileId: intent.fromPileId,
                toPileId: intent.toPileId,
                cardIds: [intent.cardId!],
              });
              engineEvents.push({
                type: "move-cards",
                fromPileId: intent.toPileId,
                toPileId: `${intent.playerId}-hand`,
                cardIds: [joker.id],
              });
              nextRS.turnPhase = "must-reuse-joker";
              nextRS.mandatoryMeldCardId = joker.id;
              nextRS.cardsPlayedToMeldsThisTurn = [
                ...nextRS.cardsPlayedToMeldsThisTurn,
                intent.cardId!,
              ];
              recomputeDerived(state, nextRS, engineEvents);
              return { valid: true, engineEvents };
            }
          }

          if (
            isBlackTwo(movingCard) &&
            intent.fromPileId !== `${intent.playerId}-hand`
          ) {
            return {
              valid: false,
              reason:
                "Black twos are fixed to their meld and cannot be moved to another meld.",
              engineEvents: [],
            };
          }

          // Regular meld
          const newCards = [...existingCards, movingCard];
          if (
            newCards.length >= 3
              ? !validateMeld(newCards).valid
              : !isPotentialMeld(newCards)
          ) {
            const cardLabel = formatCard(movingCard.rank, movingCard.suit);
            const targetLabel = formatMeldLabel(intent.toPileId);
            const issue =
              newCards.length >= 3
                ? describeMeldIssue(newCards, { skipOrderCheck: true })
                : null;
            const reason = issue
              ? `${cardLabel} doesn't fit ${targetLabel}: ${issue}`
              : `${cardLabel} doesn't fit ${targetLabel}.`;
            return { valid: false, reason, engineEvents: [] };
          }

          // For runs, compute the correct insertion position to maintain order
          const insertIndex = computeRunInsertIndex(existingCards, movingCard);

          engineEvents.push({
            type: "move-cards",
            fromPileId: intent.fromPileId,
            toPileId: intent.toPileId,
            cardIds: [intent.cardId!],
            ...(insertIndex !== undefined ? { targetIndex: insertIndex } : {}),
          });
          if (!nextRS.cardsPlayedToMeldsThisTurn.includes(intent.cardId!)) {
            nextRS.cardsPlayedToMeldsThisTurn = [
              ...nextRS.cardsPlayedToMeldsThisTurn,
              intent.cardId!,
            ];
          }
          if (
            rs.turnPhase === "must-meld-deepest" ||
            rs.turnPhase === "must-reuse-joker"
          ) {
            nextRS.turnPhase = "play-or-discard";
            nextRS.mandatoryMeldCardId = null;
          }
          recomputeDerived(state, nextRS, engineEvents);
          return { valid: true, engineEvents };
        }

        if (intent.toPileId === "discard") {
          if (rs.turnPhase !== "play-or-discard") {
            return {
              valid: false,
              reason: "Complete mandatory meld first.",
              engineEvents: [],
            };
          }

          // Validate all team melds
          const myTeam = teamFor(intent.playerId);
          const myMeldPiles = meldPileIdsForTeam(myTeam);
          for (const mid of myMeldPiles) {
            const p = state.piles[mid];
            if (p?.size > 0 && p.size < 3) {
              return {
                valid: false,
                reason: `${formatMeldLabel(mid)} must have at least 3 cards before discarding.`,
                engineEvents: [],
              };
            }
            if (p?.size >= 3 && p.cards) {
              // Skip order check - AI auto-orders cards, humans can manually reorder
              const issue = describeMeldIssue(p.cards, {
                skipOrderCheck: true,
              });
              if (issue) {
                return {
                  valid: false,
                  reason: `${formatMeldLabel(mid)}: ${issue}`,
                  engineEvents: [],
                };
              }
            }
          }

          engineEvents.push({
            type: "move-cards",
            fromPileId: intent.fromPileId,
            toPileId: "discard",
            cardIds: [intent.cardId!],
          });

          const projected = projectPilesAfterEvents(state, engineEvents);
          const hand = projected[`${intent.playerId}-hand`];
          const wentOut = hand.size === 0;

          const teamWithPinnacolone = teamHasPinnacolone(projected, "A")
            ? "A"
            : teamHasPinnacolone(projected, "B")
              ? "B"
              : null;

          if (teamWithPinnacolone) {
            nextRS.phase = "ended";
            engineEvents.push({
              type: "set-winner",
              winner: `Team ${teamWithPinnacolone}`,
            });
          } else if (wentOut) {
            engineEvents.push({
              type: "announce",
              text: `${intent.playerId} goes out!`,
              anchor: { type: "pile", pileId: "discard" },
            });

            const { scores } = calculateScores(projected);

            // Update scores
            nextRS.teamScores.A += scores.A;
            nextRS.teamScores.B += scores.B;

            // Check for 1000 point win
            const winner =
              nextRS.teamScores.A >= 1000
                ? "A"
                : nextRS.teamScores.B >= 1000
                  ? "B"
                  : null;
            if (winner) {
              nextRS.phase = "ended";
              engineEvents.push({
                type: "set-winner",
                winner: `Team ${winner}`,
              });
            } else {
              nextRS.hasDealt = false;
              nextRS.phase = "dealing";
            }
          } else {
            nextRS.turnPlayerId = getOtherPlayer(intent.playerId);
            nextRS.turnPhase = "must-draw";
            if (!nextRS.playersWhoDiscarded.includes(intent.playerId)) {
              nextRS.playersWhoDiscarded = [
                ...nextRS.playersWhoDiscarded,
                intent.playerId,
              ];
            }
            engineEvents.push({
              type: "set-current-player",
              player: nextRS.turnPlayerId,
            });
          }

          // Update scoreboard
          const cells: ScoreboardCell[] = [
            { row: 0, col: 0, text: "Team", role: "header" },
            { row: 0, col: 1, text: "Score", role: "header" },
            { row: 1, col: 0, text: "Team A (S+N)", role: "body" },
            { row: 1, col: 1, text: String(nextRS.teamScores.A), role: "body" },
            { row: 2, col: 0, text: "Team B (W+E)", role: "body" },
            { row: 2, col: 1, text: String(nextRS.teamScores.B), role: "body" },
          ];
          engineEvents.push({
            type: "set-scoreboards",
            scoreboards: [
              {
                id: "pinnacola-score",
                title: "Score",
                rows: 3,
                cols: 2,
                cells,
              },
            ],
          });
          recomputeDerived(state, nextRS, engineEvents);
          return { valid: true, engineEvents };
        }

        // Unmeld
        if (
          intent.toPileId === `${intent.playerId}-hand` &&
          intent.fromPileId.startsWith(`${teamFor(intent.playerId)}-meld-`)
        ) {
          const movingCard = state.allCards[intent.cardId!];
          if (isBlackTwo(movingCard)) {
            return {
              valid: false,
              reason:
                "Black twos are fixed to their meld and cannot be removed.",
              engineEvents: [],
            };
          }
          if (!rs.cardsPlayedToMeldsThisTurn.includes(intent.cardId!))
            return {
              valid: false,
              reason: "Can only unmeld cards added this turn.",
              engineEvents: [],
            };
          engineEvents.push({
            type: "move-cards",
            fromPileId: intent.fromPileId,
            toPileId: intent.toPileId,
            cardIds: [intent.cardId!],
          });
          nextRS.cardsPlayedToMeldsThisTurn =
            nextRS.cardsPlayedToMeldsThisTurn.filter(
              (id) => id !== intent.cardId
            );
          recomputeDerived(state, nextRS, engineEvents);
          return { valid: true, engineEvents };
        }
      }
    }

    return {
      valid: false,
      reason: getTurnPhaseGuidance(rs.turnPhase),
      engineEvents: [],
    };
  },
};

export const pinnacolaPlugin: GamePlugin = {
  id: "pinnacola",
  gameName: META.gameName,
  ruleModule: pinnacolaRules,
  description: META.description,
  validationHints: {
    sharedPileIds: [
      "deck",
      "discard",
      ...meldPileIdsForTeam("A"),
      ...meldPileIdsForTeam("B"),
    ],
  },
};
