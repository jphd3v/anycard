import type {
  GameRuleModule,
  GamePlugin,
  ValidationHints,
} from "../interface.js";
import type {
  ValidationState,
  ValidationPileSummary,
} from "../../validation-state.js";
import type {
  ActionGrid,
  ClientIntent,
  Scoreboard,
} from "../../../../shared/schemas.js";
import type {
  EngineEvent,
  ValidationResult,
} from "../../../../shared/validation.js";
import { loadGameMeta } from "../meta.js";
import { formatCard, getSuitSymbol } from "../../util/card-notation.js";
import { appendHistoryDigest, type AgentGuide } from "../util/agent-guide.js";
import { projectPilesAfterEvents, type ProjectedPiles } from "../util/piles.js";
import {
  gatherAllCards,
  shuffleAllCards,
  distributeRoundRobin,
} from "../util/dealing.js";

const META = loadGameMeta("canasta");

type Team = "A" | "B";
type Phase = "setup" | "playing" | "ended";
type TurnPhase = "must-draw" | "meld-or-discard";

const PLAYERS = ["P1", "P2", "P3", "P4"] as const;
const MELD_RANKS = [
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
  "A",
] as const;

type SimpleCard = { id: number; rank: string; suit: string };

interface MeldHistoryEntry {
  hasMeldedEver: boolean;
  hasAddedToExistingMeldEver: boolean;
}

interface CanastaRulesState {
  phase: Phase;
  hasDealt: boolean;
  dealNumber: number;
  dealerIndex: number;
  players: string[];
  turnPhase: TurnPhase;
  turnStartTeamHadMeld: Record<Team, boolean>;
  tookDiscardThisTurn: boolean;
  pickedUpFromDiscardCardIds: number[];
  cardsPlayedToMeldsThisTurn: number[];
  meldHistory: Record<string, MeldHistoryEntry>;
  gameScore: Record<Team, number>;
  lastHandScore: Record<Team, number>;
  result: string | null;
  /**
   * Helpful metadata and turn-specific constraints for AI agents.
   */
  agentGuide?: AgentGuide & {
    turnStatus?: {
      turnPhase: TurnPhase;
      mustEndTurnByDiscard: boolean;
      canGoOutNow: boolean;
      hasCanasta: boolean;
    };
    commitValidation?: {
      canCommitNow: boolean;
      rejectReasons: string[] | null;
      openingMeldPointsNeeded: number;
      openingMeldPointsIfCommitNow: number;
      openingMeldSatisfiedIfCommitNow: boolean;
      mustKeepCardsInHandMin: number;
      wouldGoOutIfCommitNow: boolean;
    };
    lastRejection?: { code: string; details?: Record<string, unknown> } | null;
    executionNotes?: string[];
    deckMeta?: {
      decks: number;
      jokersPerDeck: number;
      totalCards: number;
      duplicatesPossible: boolean;
      cardUniqueness: "id";
    };
  };
}

function teamFor(playerId: string): Team {
  return playerId === "P1" || playerId === "P3" ? "A" : "B";
}

function nextPlayerClockwise(current: string): string {
  const idx = PLAYERS.indexOf(current as (typeof PLAYERS)[number]);
  if (idx === -1) return "P1";
  return PLAYERS[(idx + 1) % PLAYERS.length];
}

function readTeamNumber(obj: unknown, key: Team, fallback: number): number {
  if (!obj || typeof obj !== "object") return fallback;
  const val = (obj as Record<string, unknown>)[key];
  return typeof val === "number" ? val : fallback;
}

function readTeamBoolean(obj: unknown, key: Team, fallback: boolean): boolean {
  if (!obj || typeof obj !== "object") return fallback;
  const val = (obj as Record<string, unknown>)[key];
  return typeof val === "boolean" ? val : fallback;
}

function getRulesState(raw: unknown): CanastaRulesState {
  const base: CanastaRulesState = {
    phase: "setup",
    hasDealt: false,
    dealNumber: 0,
    dealerIndex: 0,
    players: [...PLAYERS],
    turnPhase: "must-draw",
    turnStartTeamHadMeld: { A: false, B: false },
    tookDiscardThisTurn: false,
    pickedUpFromDiscardCardIds: [],
    cardsPlayedToMeldsThisTurn: [],
    meldHistory: {},
    gameScore: { A: 0, B: 0 },
    lastHandScore: { A: 0, B: 0 },
    result: null,
    agentGuide: {
      historyDigest: [],
      lastRejection: null,
    },
  };

  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Partial<CanastaRulesState>;

  const meldHistory: Record<string, MeldHistoryEntry> = {};
  const rawHistory = (obj as unknown as Record<string, unknown>)["meldHistory"];
  if (rawHistory && typeof rawHistory === "object") {
    for (const [playerId, entry] of Object.entries(
      rawHistory as Record<string, unknown>
    )) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      meldHistory[playerId] = {
        hasMeldedEver:
          typeof e.hasMeldedEver === "boolean" ? e.hasMeldedEver : false,
        hasAddedToExistingMeldEver:
          typeof e.hasAddedToExistingMeldEver === "boolean"
            ? e.hasAddedToExistingMeldEver
            : false,
      };
    }
  }

  const agentGuide = normalizeAgentGuide(obj.agentGuide) ?? base.agentGuide;

  return {
    ...base,
    ...obj,
    players:
      Array.isArray(obj.players) && obj.players.length === 4
        ? obj.players
        : base.players,
    gameScore: {
      A: readTeamNumber(obj.gameScore, "A", base.gameScore.A),
      B: readTeamNumber(obj.gameScore, "B", base.gameScore.B),
    },
    lastHandScore: {
      A: readTeamNumber(obj.lastHandScore, "A", base.lastHandScore.A),
      B: readTeamNumber(obj.lastHandScore, "B", base.lastHandScore.B),
    },
    result: obj.result ?? base.result,
    turnStartTeamHadMeld: {
      A: readTeamBoolean(
        obj.turnStartTeamHadMeld,
        "A",
        base.turnStartTeamHadMeld.A
      ),
      B: readTeamBoolean(
        obj.turnStartTeamHadMeld,
        "B",
        base.turnStartTeamHadMeld.B
      ),
    },
    meldHistory,
    pickedUpFromDiscardCardIds: Array.isArray(obj.pickedUpFromDiscardCardIds)
      ? obj.pickedUpFromDiscardCardIds.filter(
          (n): n is number => typeof n === "number"
        )
      : [],
    cardsPlayedToMeldsThisTurn: Array.isArray(obj.cardsPlayedToMeldsThisTurn)
      ? obj.cardsPlayedToMeldsThisTurn.filter(
          (n): n is number => typeof n === "number"
        )
      : [],
    agentGuide,
  };
}

function normalizeAgentGuide(
  agentGuide: CanastaRulesState["agentGuide"] | undefined
): CanastaRulesState["agentGuide"] {
  if (!agentGuide) return agentGuide;
  const legacyHistory = (agentGuide as { history?: unknown }).history;
  const historyDigest = Array.isArray(agentGuide.historyDigest)
    ? agentGuide.historyDigest
    : Array.isArray(legacyHistory)
      ? legacyHistory.filter(
          (entry): entry is string => typeof entry === "string"
        )
      : undefined;
  if (!historyDigest || agentGuide.historyDigest) {
    return agentGuide;
  }
  const rest = { ...(agentGuide as Record<string, unknown>) };
  delete rest.history;
  return { ...rest, historyDigest } as CanastaRulesState["agentGuide"];
}

function formatTurnDigest(
  playerId: string,
  rulesState: CanastaRulesState,
  discarded: SimpleCard | null,
  wentOut: boolean
): string {
  const parts: string[] = [];
  const drawLabel = rulesState.tookDiscardThisTurn
    ? "took discard pile"
    : "drew from stock";
  parts.push(drawLabel);
  const meldCount = rulesState.cardsPlayedToMeldsThisTurn.length;
  if (meldCount > 0) {
    parts.push(`melded ${meldCount} card${meldCount === 1 ? "" : "s"}`);
  }
  if (discarded) {
    parts.push(`discarded ${formatCard(discarded.rank, discarded.suit)}`);
  }
  if (wentOut) {
    parts.push("went out");
  }
  return `${playerId}: ${parts.join(", ")}.`;
}

function pileCards(pile: ValidationPileSummary | null): SimpleCard[] {
  return (
    pile?.cards?.map((c) => ({ id: c.id, rank: c.rank, suit: c.suit })) ?? []
  );
}

function topCard(pile: ValidationPileSummary | null): SimpleCard | null {
  if (!pile?.cards || pile.cards.length === 0) return null;
  const c = pile.cards[pile.cards.length - 1];
  return { id: c.id, rank: c.rank, suit: c.suit };
}

function isRedThree(card: SimpleCard): boolean {
  return (
    card.rank === "3" && (card.suit === "hearts" || card.suit === "diamonds")
  );
}

function isBlackThree(card: SimpleCard): boolean {
  return card.rank === "3" && (card.suit === "clubs" || card.suit === "spades");
}

function isWild(card: SimpleCard): boolean {
  return card.rank === "2" || card.rank === "JOKER";
}

function isNaturalMeldRank(rank: string): boolean {
  return (MELD_RANKS as readonly string[]).includes(rank);
}

function cardPointValue(card: SimpleCard): number {
  if (card.rank === "JOKER") return 50;
  if (card.rank === "A" || card.rank === "2") return 20;
  if (["K", "Q", "J", "10", "9", "8"].includes(card.rank)) return 10;
  if (["7", "6", "5", "4"].includes(card.rank)) return 5;
  if (card.rank === "3") return isBlackThree(card) ? 5 : 0;
  return 0;
}

function initialMeldMinForScore(score: number): number {
  if (score < 0) return 15;
  if (score <= 1495) return 50;
  if (score <= 2995) return 90;
  return 120;
}

function meldPileId(team: Team, rank: string): string {
  return `${team}-meld-${rank}`;
}

function allMeldPileIdsForTeam(team: Team): string[] {
  return (MELD_RANKS as readonly string[]).map((r) => meldPileId(team, r));
}

function teamHasAnyMeld(state: ValidationState, team: Team): boolean {
  return allMeldPileIdsForTeam(team).some(
    (id) => (state.piles[id]?.size ?? 0) > 0
  );
}

function teamHasCanasta(state: ValidationState, team: Team): boolean {
  return allMeldPileIdsForTeam(team).some(
    (id) => (state.piles[id]?.size ?? 0) >= 7
  );
}

function isDiscardFrozen(state: ValidationState): boolean {
  const discard = pileCards(state.piles["discard"]);
  return discard.some((c) => isWild(c) || isRedThree(c));
}

function computeCardVisuals(
  state: ValidationState
): Record<number, { rotationDeg?: number }> {
  const visuals: Record<number, { rotationDeg?: number }> = {};

  // Discard freeze marker: any wild card in the discard pile is placed sideways.
  for (const c of pileCards(state.piles["discard"])) {
    if (isWild(c) || isRedThree(c)) {
      visuals[c.id] = { rotationDeg: 90 };
    }
  }

  return visuals;
}

function buildActions(
  state: ValidationState,
  rulesState: CanastaRulesState
): ActionGrid {
  const isOver = !!state.winner || rulesState.phase === "ended";
  const isSetup = !rulesState.hasDealt || rulesState.phase === "setup";
  const current = state.currentPlayer;

  const cells: ActionGrid["cells"] = [];

  if (isSetup || isOver) {
    return { rows: 0, cols: 0, cells: [] };
  }

  const deckEmpty = (state.piles["deck"]?.size ?? 0) === 0;

  if (rulesState.turnPhase === "must-draw") {
    if (deckEmpty) {
      cells.push({
        row: 0,
        col: 1,
        id: "end-hand-empty-stock",
        label: "End hand (no stock)",
        enabled: !!current,
      });
      return { rows: 1, cols: 2, cells };
    }
    return { rows: 0, cols: 0, cells: [] };
  }

  // meld-or-discard
  const hand = current ? pileCards(state.piles[`${current}-hand`]) : [];
  const canGoOut =
    !!current &&
    hand.length === 0 &&
    !!current &&
    teamHasCanasta(state, teamFor(current));
  cells.push({
    row: 0,
    col: 0,
    id: "go-out",
    label: "Go out (no discard)",
    enabled: canGoOut,
  });

  return { rows: 1, cols: 1, cells };
}

function buildScoreboard(
  state: ValidationState,
  rulesState: CanastaRulesState
): Scoreboard {
  const aScore = rulesState.gameScore.A ?? 0;
  const bScore = rulesState.gameScore.B ?? 0;

  const discardTop = topCard(state.piles["discard"]);
  const deckSize = state.piles["deck"]?.size ?? 0;
  const discardSize = state.piles["discard"]?.size ?? 0;

  const teamAHasMeld = teamHasAnyMeld(state, "A");
  const teamBHasMeld = teamHasAnyMeld(state, "B");
  const teamAHasCanasta = teamHasCanasta(state, "A");
  const teamBHasCanasta = teamHasCanasta(state, "B");

  const rows = 7;
  const cols = 4;
  const cells: Scoreboard["cells"] = [
    { row: 0, col: 0, text: "Team", role: "header", align: "left" },
    { row: 0, col: 1, text: "Players", role: "header", align: "left" },
    { row: 0, col: 2, text: "Hand", role: "header", align: "right" },
    { row: 0, col: 3, text: "Total", role: "header", align: "right" },

    { row: 1, col: 0, text: "A", role: "header", align: "left" },
    { row: 1, col: 1, text: "P1 & P3", align: "left" },
    {
      row: 1,
      col: 2,
      text: String(rulesState.lastHandScore.A ?? 0),
      align: "right",
    },
    { row: 1, col: 3, text: String(aScore), role: "total", align: "right" },

    { row: 2, col: 0, text: "B", role: "header", align: "left" },
    { row: 2, col: 1, text: "P2 & P4", align: "left" },
    {
      row: 2,
      col: 2,
      text: String(rulesState.lastHandScore.B ?? 0),
      align: "right",
    },
    { row: 2, col: 3, text: String(bScore), role: "total", align: "right" },

    { row: 3, col: 0, text: `Deal: ${rulesState.dealNumber}`, align: "left" },
    {
      row: 3,
      col: 1,
      text: `Dealer: ${PLAYERS[rulesState.dealerIndex % 4]}`,
      align: "left",
    },
    {
      row: 3,
      col: 2,
      text: `Turn: ${state.currentPlayer ?? "-"}`,
      align: "left",
    },
    { row: 3, col: 3, text: `Phase: ${rulesState.turnPhase}`, align: "left" },

    { row: 4, col: 0, text: `Stock: ${deckSize}`, align: "left" },
    { row: 4, col: 1, text: `Discard: ${discardSize}`, align: "left" },
    {
      row: 4,
      col: 2,
      text: `Top: ${discardTop ? formatCard(discardTop.rank, discardTop.suit) : "-"}`,
      align: "left",
    },
    {
      row: 4,
      col: 3,
      text: `Frozen: ${isDiscardFrozen(state) ? "yes" : "no"}`,
      align: "left",
    },

    {
      row: 5,
      col: 0,
      text: `A melded: ${teamAHasMeld ? "yes" : "no"}`,
      align: "left",
    },
    {
      row: 5,
      col: 1,
      text: `A canasta: ${teamAHasCanasta ? "yes" : "no"}`,
      align: "left",
    },
    {
      row: 5,
      col: 2,
      text: `B melded: ${teamBHasMeld ? "yes" : "no"}`,
      align: "left",
    },
    {
      row: 5,
      col: 3,
      text: `B canasta: ${teamBHasCanasta ? "yes" : "no"}`,
      align: "left",
    },

    { row: 6, col: 0, text: "Goal: 5000", align: "left" },
    { row: 6, col: 1, text: "", align: "left" },
    { row: 6, col: 2, text: "", align: "left" },
    { row: 6, col: 3, text: "", align: "left" },
  ];

  return {
    id: "canasta-main",
    title: "Canasta",
    rows,
    cols,
    cells,
  };
}

function moveRedThreesOut(
  state: ValidationState,
  playerId: string,
  engineEvents: EngineEvent[]
): void {
  // Use projected piles so we can iterate replacement draws.
  // This is deterministic because deck order is already fixed.
  while (true) {
    const projected = projectPilesAfterEvents(state, engineEvents);
    const hand = projected[`${playerId}-hand`]?.cards ?? [];
    const firstRed3 = hand.find(isRedThree);
    if (!firstRed3) break;

    engineEvents.push({
      type: "move-cards",
      fromPileId: `${playerId}-hand`,
      toPileId: `${teamFor(playerId)}-red3`,
      cardIds: [firstRed3.id],
    });

    const deck = projected["deck"]?.cards ?? [];
    if (deck.length === 0) {
      return;
    }
    const replacement = deck[deck.length - 1];
    engineEvents.push({
      type: "move-cards",
      fromPileId: "deck",
      toPileId: `${playerId}-hand`,
      cardIds: [replacement.id],
    });
  }
}

function ensureInitialDiscardTopIsLegal(
  state: ValidationState,
  engineEvents: EngineEvent[]
): void {
  // Continue flipping until discard top is not wild and not red three.
  while (true) {
    const projected = projectPilesAfterEvents(state, engineEvents);
    const discard = projected["discard"]?.cards ?? [];
    const deck = projected["deck"]?.cards ?? [];
    const top = discard.length ? discard[discard.length - 1] : null;
    if (!top) break;
    if (!isWild(top) && !isRedThree(top)) break;
    if (deck.length === 0) break;

    const next = deck[deck.length - 1];
    engineEvents.push({
      type: "move-cards",
      fromPileId: "deck",
      toPileId: "discard",
      cardIds: [next.id],
    });
  }
}

function validateMeldPileContents(
  cards: SimpleCard[],
  rank: string,
  checkMinimums: boolean = true
): string | null {
  if (!isNaturalMeldRank(rank)) return "Invalid meld rank.";
  for (const c of cards) {
    if (c.rank === "3") return "Threes cannot be melded in rank melds.";
    if (isWild(c)) continue;
    if (c.rank !== rank)
      return `Meld pile for ${rank}s contains wrong rank: ${formatCard(c.rank, c.suit)}.`;
  }

  const wildCount = cards.filter(isWild).length;
  const naturalCount = cards.length - wildCount;

  if (checkMinimums) {
    if (cards.length > 0 && naturalCount < 2)
      return `Each meld must contain at least two natural cards (current: ${naturalCount}).`;
    if (cards.length > 0 && naturalCount === 0)
      return "Melds of only wild cards are not allowed.";
  }
  if (wildCount > 3) return "A meld cannot contain more than three wild cards.";

  return null;
}

function canStartOrExtendMeld(
  state: ValidationState,
  playerId: string,
  targetPileId: string,
  moving: SimpleCard
): string | null {
  const meldIndex = targetPileId.indexOf("-meld-");
  const targetRank =
    meldIndex >= 0 ? targetPileId.slice(meldIndex + "-meld-".length) : "";
  const targetPile = pileCards(state.piles[targetPileId] ?? null);
  const targetNaturals = targetPile.filter(
    (c) => !isWild(c) && c.rank === targetRank
  ).length;
  const movingIsNatural = !isWild(moving) && moving.rank === targetRank;

  const hand = pileCards(state.piles[`${playerId}-hand`] ?? null);
  const remainingNaturals = hand.filter(
    (c) => c.id !== moving.id && !isWild(c) && c.rank === targetRank
  ).length;
  const totalNaturalsAvailable =
    targetNaturals + (movingIsNatural ? 1 : 0) + remainingNaturals;

  if (targetPile.length === 0) {
    if (!movingIsNatural) {
      return "A meld cannot start with a wild card. Place two natural cards first.";
    }
    if (totalNaturalsAvailable < 2) {
      return `You need two natural ${targetRank}s to start a meld.`;
    }
  } else if (!movingIsNatural && targetNaturals < 2) {
    return "Wild cards can only be added after at least two natural cards are in the meld.";
  }

  return null;
}

function canGoOutWithoutInitialMeldMinimum(
  state: ValidationState,
  rulesState: CanastaRulesState,
  playerId: string,
  movingCard: SimpleCard | null
): boolean {
  if (rulesState.turnPhase !== "meld-or-discard") return false;
  if (rulesState.tookDiscardThisTurn) return false;

  const team = teamFor(playerId);
  const hadMeldBefore = rulesState.turnStartTeamHadMeld?.[team] ?? false;
  if (hadMeldBefore) return false;

  const hand = pileCards(state.piles[`${playerId}-hand`] ?? null);
  const cards =
    movingCard && !hand.some((c) => c.id === movingCard.id)
      ? [...hand, movingCard]
      : hand;

  if (cards.some(isRedThree)) return false;

  const discardOptions = [null, ...cards];
  for (const discard of discardOptions) {
    const remaining = discard
      ? cards.filter((c) => c.id !== discard.id)
      : cards;

    const black3Count = remaining.filter(isBlackThree).length;
    if (!(black3Count === 0 || black3Count === 3 || black3Count === 4)) {
      continue;
    }

    let wildCount = 0;
    const naturalsByRank: Record<string, number> = {};
    for (const c of remaining) {
      if (isBlackThree(c)) continue;
      if (isWild(c)) {
        wildCount += 1;
        continue;
      }
      if (!isNaturalMeldRank(c.rank)) return false;
      naturalsByRank[c.rank] = (naturalsByRank[c.rank] ?? 0) + 1;
    }

    const entries = Object.entries(naturalsByRank);
    if (entries.length === 0) continue;
    if (entries.some(([, count]) => count === 1)) continue;

    const maxWildCapacity = entries.length * 3;
    if (wildCount > maxWildCapacity) continue;

    const rankCounts = entries.map(([, count]) => count);
    const dfs = (
      idx: number,
      remainingWilds: number,
      hasCanasta: boolean
    ): boolean => {
      if (idx >= rankCounts.length) {
        return remainingWilds === 0 && hasCanasta;
      }
      const naturals = rankCounts[idx];
      const minWild = Math.max(0, 3 - naturals);
      const maxWild = Math.min(3, remainingWilds);
      if (minWild > maxWild) return false;

      for (let w = minWild; w <= maxWild; w += 1) {
        const canastaNow = hasCanasta || naturals + w >= 7;
        if (dfs(idx + 1, remainingWilds - w, canastaNow)) return true;
      }
      return false;
    };

    if (dfs(0, wildCount, false)) return true;
  }

  return false;
}

function canMeetInitialMeldMinimum(
  state: ValidationState,
  rulesState: CanastaRulesState,
  playerId: string,
  movingCard: SimpleCard | null
): boolean {
  const team = teamFor(playerId);
  const hadMeldBefore = rulesState.turnStartTeamHadMeld?.[team] ?? false;
  if (hadMeldBefore) return true;

  const hasMeldNow = allMeldPileIdsForTeam(team).some(
    (id) => (state.piles[id]?.size ?? 0) >= 3
  );
  if (hasMeldNow) return true;

  const min = initialMeldMinForScore(rulesState.gameScore[team] ?? 0);
  const hand = pileCards(state.piles[`${playerId}-hand`] ?? null);
  const cards =
    movingCard && !hand.some((c) => c.id === movingCard.id)
      ? [...hand, movingCard]
      : hand;

  let totalPoints = 0;
  let wildCount = 0;
  const naturalsByRank: Record<string, number> = {};
  for (const c of cards) {
    if (isRedThree(c) || isBlackThree(c)) continue;
    totalPoints += cardPointValue(c);
    if (isWild(c)) {
      wildCount += 1;
    } else if (isNaturalMeldRank(c.rank)) {
      naturalsByRank[c.rank] = (naturalsByRank[c.rank] ?? 0) + 1;
    }
  }

  if (totalPoints < min) {
    return canGoOutWithoutInitialMeldMinimum(
      state,
      rulesState,
      playerId,
      movingCard
    );
  }

  for (const rank of Object.keys(naturalsByRank)) {
    const naturalCount = naturalsByRank[rank] ?? 0;
    if (naturalCount < 2) continue;
    if (naturalCount + Math.min(wildCount, 3) >= 3) {
      return true;
    }
  }

  return canGoOutWithoutInitialMeldMinimum(
    state,
    rulesState,
    playerId,
    movingCard
  );
}

function sumMeldCardValues(
  state: ValidationState,
  team: Team,
  excludeCardIds: Set<number>
): number {
  let total = 0;
  for (const rank of MELD_RANKS) {
    const pileId = meldPileId(team, rank);
    for (const c of pileCards(state.piles[pileId] ?? null)) {
      if (excludeCardIds.has(c.id)) continue;
      total += cardPointValue(c);
    }
  }
  // Black-threes-out pile counts as melded cards (only allowed on last turn).
  for (const c of pileCards(state.piles[`${team}-black3-out`] ?? null)) {
    if (excludeCardIds.has(c.id)) continue;
    total += cardPointValue(c);
  }
  return total;
}

function computeHandScore(
  state: ValidationState,
  wentOutTeam: Team | null,
  concealedOutTeam: Team | null
): Record<Team, number> {
  const totals: Record<Team, number> = { A: 0, B: 0 };

  for (const team of ["A", "B"] as const) {
    // bonuses
    if (wentOutTeam === team) {
      totals[team] += concealedOutTeam === team ? 200 : 100;
    }

    for (const rank of MELD_RANKS) {
      const cards = pileCards(state.piles[meldPileId(team, rank)] ?? null);
      if (cards.length >= 7) {
        const wild = cards.some(isWild);
        totals[team] += wild ? 300 : 500;
      }
    }

    // red threes
    const red3Count = state.piles[`${team}-red3`]?.size ?? 0;
    const hasMeld = teamHasAnyMeld(state, team);
    if (red3Count > 0) {
      const base = hasMeld ? 100 : -100;
      totals[team] += red3Count * base;
      if (red3Count === 4) {
        totals[team] += hasMeld ? 400 : -400;
      }
    }

    // melded card values (excluding red threes)
    for (const rank of MELD_RANKS) {
      for (const c of pileCards(state.piles[meldPileId(team, rank)] ?? null)) {
        totals[team] += cardPointValue(c);
      }
    }
    for (const c of pileCards(state.piles[`${team}-black3-out`] ?? null)) {
      totals[team] += cardPointValue(c);
    }
  }

  // subtract remaining hand cards
  for (const pid of PLAYERS) {
    const team = teamFor(pid);
    for (const c of pileCards(state.piles[`${pid}-hand`] ?? null)) {
      totals[team] -= cardPointValue(c);
    }
  }

  return totals;
}

function checkBoardValidity(
  state: ValidationState,
  team: Team,
  rulesState: CanastaRulesState,
  currentPlayerId: string | null
): string | null {
  // Validate meld pile invariants at end of turn.
  for (const rank of MELD_RANKS) {
    const pileId = meldPileId(team, rank);
    const pile = state.piles[pileId];
    const cards = pileCards(pile ?? null);

    const err = validateMeldPileContents(cards, rank, true); // strict check
    if (err) return err;

    if (cards.length > 0 && cards.length < 3) {
      return "All melds must have at least three cards by end of turn.";
    }
  }

  const black3Out = pileCards(state.piles[`${team}-black3-out`] ?? null);
  if (black3Out.length > 0) {
    if (!(black3Out.length === 3 || black3Out.length === 4)) {
      return "Black threes can only be melded as 3 or 4 when going out.";
    }
    if (!black3Out.every(isBlackThree)) {
      return "Black threes meld may not contain wild cards.";
    }
  }

  // Initial meld minimum check
  const hadMeldBefore = rulesState.turnStartTeamHadMeld?.[team] ?? false;
  const hasMeldAfter = allMeldPileIdsForTeam(team).some(
    (id) => (state.piles[id]?.size ?? 0) >= 3
  );

  if (!hadMeldBefore && hasMeldAfter) {
    const canSkipInitialMinimum =
      !!currentPlayerId &&
      (state.piles[`${currentPlayerId}-hand`]?.size ?? 0) === 0 &&
      teamHasCanasta(state, team) &&
      !rulesState.tookDiscardThisTurn;
    if (!canSkipInitialMinimum) {
      const min = initialMeldMinForScore(rulesState.gameScore[team] ?? 0);
      const exclude = new Set<number>(
        rulesState.tookDiscardThisTurn
          ? (rulesState.pickedUpFromDiscardCardIds ?? [])
          : []
      );
      const value = sumMeldCardValues(state, team, exclude);
      if (value < min) {
        return `Initial meld minimum is ${min} points (your current meld value: ${value}).`;
      }
    }
  }

  return null;
}

function recomputeDerived(
  state: ValidationState,
  rulesState: CanastaRulesState,
  engineEvents: EngineEvent[]
): void {
  const projectedPiles = projectPilesAfterEvents(state, engineEvents);
  const projectedState: ValidationState = {
    ...state,
    piles: (() => {
      const next: Record<string, ValidationPileSummary> = { ...state.piles };
      for (const [pileId, pile] of Object.entries(projectedPiles)) {
        const base = state.piles[pileId] ?? {
          id: pileId,
          ownerId: null,
          size: 0,
        };
        next[pileId] = {
          ...base,
          size: pile.size,
          cards: (pile.cards ?? []).map((c) => ({ ...c })),
        };
      }
      return next;
    })(),
  };

  const current = state.currentPlayer;
  const team = current ? teamFor(current) : null;
  const hasCanasta = !!team && teamHasCanasta(projectedState, team);
  const initialMeldPointsNeeded = team
    ? initialMeldMinForScore(rulesState.gameScore[team] ?? 0)
    : 0;

  let initialMeldPointsCurrent = 0;
  let openingMeldPointsIfCommitNow = 0;
  let openingMeldSatisfiedIfCommitNow = false;

  if (team) {
    const hadMeldBefore = rulesState.turnStartTeamHadMeld?.[team] ?? false;
    const hasMeldNow = allMeldPileIdsForTeam(team).some(
      (id) => (projectedState.piles[id]?.size ?? 0) >= 3
    );

    const exclude = new Set<number>(
      rulesState.tookDiscardThisTurn
        ? (rulesState.pickedUpFromDiscardCardIds ?? [])
        : []
    );
    initialMeldPointsCurrent = sumMeldCardValues(projectedState, team, exclude);

    if (hadMeldBefore) {
      initialMeldPointsCurrent = initialMeldPointsNeeded;
      openingMeldSatisfiedIfCommitNow = true;
      openingMeldPointsIfCommitNow = initialMeldPointsNeeded;
    } else {
      openingMeldPointsIfCommitNow = initialMeldPointsCurrent;
      openingMeldSatisfiedIfCommitNow =
        hasMeldNow && openingMeldPointsIfCommitNow >= initialMeldPointsNeeded;
    }
  }

  const handSize = current
    ? (projectedState.piles[`${current}-hand`]?.size ?? 0)
    : 0;
  const canGoOutIfCommitNow = hasCanasta && handSize === 0;
  const mustKeepCardsInHandMin = hasCanasta ? 0 : 1;

  // Board validity check for "canCommitNow"
  const boardError = team
    ? checkBoardValidity(projectedState, team, rulesState, current)
    : "No team";
  // Structured rejection codes for AI
  const rejectReasons: string[] = [];
  if (rulesState.turnPhase === "meld-or-discard") {
    if (boardError) {
      if (boardError.includes("three")) rejectReasons.push("MELD_TOO_SMALL");
      if (boardError.includes("Initial"))
        rejectReasons.push("INITIAL_MELD_TOO_LOW");
      if (boardError.includes("canasta"))
        rejectReasons.push("NO_CANASTA_CANNOT_GO_OUT");
      if (rejectReasons.length === 0) rejectReasons.push("INVALID_BOARD_STATE");
    }
    if (handSize === 0 && !hasCanasta) {
      rejectReasons.push("HAND_EMPTY_BUT_NO_CANASTA");
    }
  }
  const canCommitNow =
    rulesState.turnPhase === "meld-or-discard" && rejectReasons.length === 0;

  const updatedRulesState: CanastaRulesState = {
    ...rulesState,
    agentGuide: {
      ...rulesState.agentGuide,
      turnStatus: {
        turnPhase: rulesState.turnPhase,
        mustEndTurnByDiscard: rulesState.turnPhase === "meld-or-discard",
        canGoOutNow:
          rulesState.turnPhase === "meld-or-discard" && canGoOutIfCommitNow,
        hasCanasta,
      },
      commitValidation: {
        canCommitNow: !!canCommitNow,
        rejectReasons: rejectReasons.length > 0 ? rejectReasons : null,
        openingMeldPointsNeeded: initialMeldPointsNeeded,
        openingMeldPointsIfCommitNow,
        openingMeldSatisfiedIfCommitNow,
        mustKeepCardsInHandMin,
        wouldGoOutIfCommitNow: canGoOutIfCommitNow,
      },
      executionNotes: [
        "Turn is committed only when discarding to the discard pile.",
        "Intermediate meld moves may create temporarily invalid table states; only the commit action determines if the turn can end.",
        "Multiple decks: identical rank+suit cards can exist; treat cards as distinct by id.",
      ],
      deckMeta: {
        decks: 2,
        jokersPerDeck: 2,
        totalCards: 108,
        duplicatesPossible: true,
        cardUniqueness: "id",
      },
    },
  };

  engineEvents.push({
    type: "set-actions",
    actions: buildActions(projectedState, updatedRulesState),
  });
  engineEvents.push({
    type: "set-scoreboards",
    scoreboards: [buildScoreboard(projectedState, updatedRulesState)],
  });
  engineEvents.push({
    type: "set-card-visuals",
    visuals: computeCardVisuals(projectedState),
  });
  engineEvents.push({
    type: "set-rules-state",
    rulesState: updatedRulesState,
  });
}

function buildStateFromProjected(
  state: ValidationState,
  projected: ProjectedPiles
): ValidationState {
  return {
    ...state,
    piles: (() => {
      const next: Record<string, ValidationPileSummary> = { ...state.piles };
      for (const [pileId, pile] of Object.entries(projected)) {
        const base = state.piles[pileId] ?? {
          id: pileId,
          ownerId: null,
          size: 0,
        };
        next[pileId] = {
          ...base,
          size: pile.size,
          cards: (pile.cards ?? []).map((c) => ({ ...c })),
        };
      }
      return next;
    })(),
  };
}

export const canastaRules: GameRuleModule = {
  listLegalIntentsForPlayer(
    state: ValidationState,
    playerId: string
  ): ClientIntent[] {
    const rulesState = getRulesState(state.rulesState);
    const intents: ClientIntent[] = [];
    const gameId = state.gameId;

    if (state.winner || rulesState.phase === "ended") return intents;
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

    if (state.currentPlayer && state.currentPlayer !== playerId) return intents;

    const candidates: ClientIntent[] = [];
    const myTeam = teamFor(playerId);
    const hand = pileCards(state.piles[`${playerId}-hand`] ?? null);
    const meldPiles = allMeldPileIdsForTeam(myTeam);

    if (rulesState.turnPhase === "must-draw") {
      const deckTop = topCard(state.piles["deck"] ?? null);
      if (deckTop) {
        candidates.push({
          type: "move",
          gameId,
          playerId,
          fromPileId: "deck",
          toPileId: `${playerId}-hand`,
          cardId: deckTop.id,
        });
      }

      const discardTop = topCard(state.piles["discard"] ?? null);
      if (
        discardTop &&
        isNaturalMeldRank(discardTop.rank) &&
        !isWild(discardTop) &&
        !isBlackThree(discardTop)
      ) {
        candidates.push({
          type: "move",
          gameId,
          playerId,
          fromPileId: "discard",
          toPileId: meldPileId(myTeam, discardTop.rank),
          cardId: discardTop.id,
        });
      }

      candidates.push({
        type: "action",
        gameId,
        playerId,
        action: "end-hand-empty-stock",
      });
    } else if (rulesState.turnPhase === "meld-or-discard") {
      candidates.push({ type: "action", gameId, playerId, action: "go-out" });

      for (const c of hand) {
        candidates.push({
          type: "move",
          gameId,
          playerId,
          fromPileId: `${playerId}-hand`,
          toPileId: "discard",
          cardId: c.id,
        });
        candidates.push({
          type: "move",
          gameId,
          playerId,
          fromPileId: `${playerId}-hand`,
          toPileId: `${myTeam}-black3-out`,
          cardId: c.id,
        });
        if (isWild(c)) {
          for (const mid of meldPiles) {
            if (!canStartOrExtendMeld(state, playerId, mid, c)) {
              candidates.push({
                type: "move",
                gameId,
                playerId,
                fromPileId: `${playerId}-hand`,
                toPileId: mid,
                cardId: c.id,
              });
            }
          }
        } else if (isNaturalMeldRank(c.rank)) {
          const mid = meldPileId(myTeam, c.rank);
          if (!canStartOrExtendMeld(state, playerId, mid, c)) {
            candidates.push({
              type: "move",
              gameId,
              playerId,
              fromPileId: `${playerId}-hand`,
              toPileId: mid,
              cardId: c.id,
            });
          }
        }
      }

      for (const mid of meldPiles) {
        const pile = pileCards(state.piles[mid] ?? null);
        for (const c of pile) {
          candidates.push({
            type: "move",
            gameId,
            playerId,
            fromPileId: mid,
            toPileId: `${playerId}-hand`,
            cardId: c.id,
          });
        }
      }
    }

    for (const c of candidates) {
      if (this.validate(state, c).valid) {
        intents.push(c);
      }
    }

    return intents;
  },

  validate(state: ValidationState, intent: ClientIntent): ValidationResult {
    const rulesState = getRulesState(state.rulesState);
    const engineEvents: EngineEvent[] = [];
    let nextRulesState: CanastaRulesState = { ...rulesState };

    if (!rulesState.hasDealt) {
      if (intent.type !== "action" || intent.action !== "start-game") {
        return {
          valid: false,
          reason: "Game has not started. Use Start game.",
          engineEvents: [],
        };
      }

      const nextDealNumber = rulesState.dealNumber + 1;

      const shuffledCardIds = shuffleAllCards(state, nextDealNumber, "CANASTA");

      // Gather all cards to the deck before dealing.
      engineEvents.push(
        ...gatherAllCards(state, { previousEvents: engineEvents })
      );

      nextRulesState = {
        ...nextRulesState,
        hasDealt: true,
        phase: "playing",
        dealNumber: nextDealNumber,
        turnPhase: "must-draw",
        turnStartTeamHadMeld: { A: false, B: false },
        tookDiscardThisTurn: false,
        pickedUpFromDiscardCardIds: [],
        cardsPlayedToMeldsThisTurn: [],
      };

      // Deal 11 cards each, clockwise from left of dealer
      const dealer = PLAYERS[nextRulesState.dealerIndex % 4];
      const first = nextPlayerClockwise(dealer);
      const order = [
        first,
        nextPlayerClockwise(first),
        nextPlayerClockwise(nextPlayerClockwise(first)),
        dealer,
      ];

      nextRulesState = {
        ...nextRulesState,
        agentGuide: appendHistoryDigest(
          nextRulesState.agentGuide,
          `Hand ${nextDealNumber} started (dealer ${dealer}).`,
          { summarizePrevious: rulesState.result || undefined }
        ),
      };

      const { events: dealEvents, nextIndex: afterDealIdx } =
        distributeRoundRobin(
          shuffledCardIds,
          order.map((p) => `${p}-hand`),
          11
        );
      engineEvents.push(...dealEvents);

      // Start discard pile
      engineEvents.push({
        type: "move-cards",
        fromPileId: "deck",
        toPileId: "discard",
        cardIds: [shuffledCardIds[afterDealIdx]],
      });

      ensureInitialDiscardTopIsLegal(state, engineEvents);

      // Auto-lay red threes + replacements for all players.
      for (const pid of PLAYERS) {
        moveRedThreesOut(state, pid, engineEvents);
      }

      const afterDealProjected = projectPilesAfterEvents(state, engineEvents);
      const afterDealState = buildStateFromProjected(state, afterDealProjected);
      nextRulesState = {
        ...nextRulesState,
        turnStartTeamHadMeld: {
          A: teamHasAnyMeld(afterDealState, "A"),
          B: teamHasAnyMeld(afterDealState, "B"),
        },
      };
      engineEvents.push({ type: "set-current-player", player: first });
      recomputeDerived(state, nextRulesState, engineEvents);
      return { valid: true, engineEvents };
    }

    if (rulesState.phase !== "playing") {
      return {
        valid: false,
        reason: "The game is not in play.",
        engineEvents: [],
      };
    }

    const current = state.currentPlayer;
    if (!current) {
      return {
        valid: false,
        reason: "No current player is set.",
        engineEvents: [],
      };
    }
    if (intent.playerId !== current) {
      return { valid: false, reason: "It is not your turn.", engineEvents: [] };
    }

    // Actions
    if (intent.type === "action") {
      if (intent.action === "go-out") {
        if (rulesState.turnPhase !== "meld-or-discard") {
          return {
            valid: false,
            reason: "You cannot go out right now.",
            engineEvents: [],
          };
        }
        const hand = pileCards(state.piles[`${current}-hand`] ?? null);
        if (hand.length !== 0) {
          return {
            valid: false,
            reason: "You can only go out with an empty hand.",
            engineEvents: [],
          };
        }
        const team = teamFor(current);
        if (!teamHasCanasta(state, team)) {
          return {
            valid: false,
            reason: "Your partnership must have a canasta to go out.",
            engineEvents: [],
          };
        }

        // Score and end the hand.
        const projected = projectPilesAfterEvents(state, engineEvents);
        const handEndState = buildStateFromProjected(state, projected);

        const concealed = !rulesState.turnStartTeamHadMeld[team];
        const handScore = computeHandScore(
          handEndState,
          team,
          concealed ? team : null
        );
        const updatedGameScore: Record<Team, number> = {
          A: (rulesState.gameScore.A ?? 0) + (handScore.A ?? 0),
          B: (rulesState.gameScore.B ?? 0) + (handScore.B ?? 0),
        };

        const winner =
          updatedGameScore.A >= 5000 || updatedGameScore.B >= 5000
            ? updatedGameScore.A === updatedGameScore.B
              ? "Tie"
              : updatedGameScore.A > updatedGameScore.B
                ? "Team A (P1 & P3)"
                : "Team B (P2 & P4)"
            : null;

        nextRulesState = {
          ...nextRulesState,
          phase: winner ? "ended" : "setup",
          hasDealt: false,
          dealerIndex: (rulesState.dealerIndex + 1) % 4,
          gameScore: updatedGameScore,
          lastHandScore: handScore,
          turnPhase: "must-draw",
          tookDiscardThisTurn: false,
          pickedUpFromDiscardCardIds: [],
          cardsPlayedToMeldsThisTurn: [],
          result: `Hand ${rulesState.dealNumber} Result: ${current} went out. Team A: ${handScore.A}, Team B: ${handScore.B}.`,
          agentGuide: appendHistoryDigest(
            nextRulesState.agentGuide,
            `${current} went out (no discard).`
          ),
        };

        // Gather cards back to deck for next round
        engineEvents.push(
          ...gatherAllCards(state, { previousEvents: engineEvents })
        );

        engineEvents.push({ type: "set-current-player", player: null });
        if (winner) {
          engineEvents.push({ type: "set-winner", winner });
        }
        recomputeDerived(state, nextRulesState, engineEvents);
        return { valid: true, engineEvents };
      }

      if (intent.action === "end-hand-empty-stock") {
        if (rulesState.turnPhase !== "must-draw") {
          return {
            valid: false,
            reason: "You cannot end the hand right now.",
            engineEvents: [],
          };
        }
        if ((state.piles["deck"]?.size ?? 0) !== 0) {
          return {
            valid: false,
            reason: "Stock is not empty.",
            engineEvents: [],
          };
        }

        const myTeam = teamFor(current);
        const discardTop = topCard(state.piles["discard"] ?? null);
        const canTake = (() => {
          if (!discardTop) return false;
          if (isWild(discardTop) || isBlackThree(discardTop)) return false;
          if (!isNaturalMeldRank(discardTop.rank)) return false;
          const discardFrozenAgainstMe =
            isDiscardFrozen(state) || !teamHasAnyMeld(state, myTeam);
          if (discardFrozenAgainstMe) {
            const hand = pileCards(state.piles[`${current}-hand`] ?? null);
            return (
              hand.filter((c) => !isWild(c) && c.rank === discardTop.rank)
                .length >= 2
            );
          }
          // Not frozen: can take if it matches an existing meld, or if you can build with 2 cards / 1+wild.
          const meldPile = pileCards(
            state.piles[meldPileId(myTeam, discardTop.rank)] ?? null
          );
          if (meldPile.length > 0) return true;
          const hand = pileCards(state.piles[`${current}-hand`] ?? null);
          const naturals = hand.filter(
            (c) => !isWild(c) && c.rank === discardTop.rank
          );
          const wilds = hand.filter(isWild);
          return (
            naturals.length >= 2 || (naturals.length >= 1 && wilds.length >= 1)
          );
        })();

        if (canTake) {
          return {
            valid: false,
            reason: `You must take the discard pile if you are able (top card: ${formatCard(discardTop!.rank, discardTop!.suit)}).`,
            engineEvents: [],
          };
        }

        const handScore = computeHandScore(state, null, null);
        const updatedGameScore: Record<Team, number> = {
          A: (rulesState.gameScore.A ?? 0) + (handScore.A ?? 0),
          B: (rulesState.gameScore.B ?? 0) + (handScore.B ?? 0),
        };
        const winner =
          updatedGameScore.A >= 5000 || updatedGameScore.B >= 5000
            ? updatedGameScore.A === updatedGameScore.B
              ? "Tie"
              : updatedGameScore.A > updatedGameScore.B
                ? "Team A (P1 & P3)"
                : "Team B (P2 & P4)"
            : null;

        nextRulesState = {
          ...nextRulesState,
          phase: winner ? "ended" : "setup",
          hasDealt: false,
          dealerIndex: (rulesState.dealerIndex + 1) % 4,
          gameScore: updatedGameScore,
          lastHandScore: handScore,
          turnPhase: "must-draw",
          tookDiscardThisTurn: false,
          pickedUpFromDiscardCardIds: [],
          cardsPlayedToMeldsThisTurn: [],
          result: `Hand ${rulesState.dealNumber} Result: Stock empty. Team A: ${handScore.A}, Team B: ${handScore.B}.`,
          agentGuide: appendHistoryDigest(
            nextRulesState.agentGuide,
            `${current} ended the hand (stock empty).`
          ),
        };

        // Gather cards back to deck for next round
        engineEvents.push(
          ...gatherAllCards(state, { previousEvents: engineEvents })
        );

        engineEvents.push({ type: "set-current-player", player: null });
        if (winner) engineEvents.push({ type: "set-winner", winner });
        recomputeDerived(state, nextRulesState, engineEvents);
        return { valid: true, engineEvents };
      }

      return { valid: false, reason: "Unknown action.", engineEvents: [] };
    }

    // Moves
    if (intent.type === "move") {
      const from = intent.fromPileId;
      const to = intent.toPileId;
      const cardId = intent.cardId;

      // Drawing from stock: drag the top stock card to your hand.
      if (
        rulesState.turnPhase === "must-draw" &&
        from === "deck" &&
        to === `${current}-hand`
      ) {
        const deck = pileCards(state.piles["deck"]);
        if (deck.length === 0) {
          return { valid: false, reason: "Stock is empty.", engineEvents: [] };
        }
        const top = deck[deck.length - 1];
        if (cardId !== top.id) {
          return {
            valid: false,
            reason: "You can only draw the top card of the stock.",
            engineEvents: [],
          };
        }

        engineEvents.push({
          type: "move-cards",
          fromPileId: "deck",
          toPileId: `${current}-hand`,
          cardIds: [top.id],
        });

        moveRedThreesOut(state, current, engineEvents);

        nextRulesState = {
          ...nextRulesState,
          turnPhase: "meld-or-discard",
          tookDiscardThisTurn: false,
          pickedUpFromDiscardCardIds: [],
          cardsPlayedToMeldsThisTurn: [],
        };

        recomputeDerived(state, nextRulesState, engineEvents);
        return { valid: true, engineEvents };
      }

      // Taking the discard pile: drag top discard to your team's meld pile.
      if (rulesState.turnPhase === "must-draw" && from === "discard") {
        const discard = pileCards(state.piles["discard"]);
        if (discard.length === 0) {
          return {
            valid: false,
            reason: "Discard pile is empty.",
            engineEvents: [],
          };
        }
        const top = discard[discard.length - 1];
        if (cardId !== top.id) {
          return {
            valid: false,
            reason: "You can only take the top discard.",
            engineEvents: [],
          };
        }
        if (isWild(top) || isBlackThree(top)) {
          return {
            valid: false,
            reason:
              "You cannot take the discard pile on a wild card or black three.",
            engineEvents: [],
          };
        }
        if (!isNaturalMeldRank(top.rank)) {
          return {
            valid: false,
            reason: "Top discard cannot be melded.",
            engineEvents: [],
          };
        }

        const myTeam = teamFor(current);
        const expectedMeldPile = meldPileId(myTeam, top.rank);
        if (to !== expectedMeldPile) {
          return {
            valid: false,
            reason: `Take discard by dragging ${formatCard(top.rank, top.suit)} to the ${top.rank}${getSuitSymbol(top.suit)} meld pile.`,
            engineEvents: [],
          };
        }

        const frozenAgainstMe =
          isDiscardFrozen(state) || !teamHasAnyMeld(state, myTeam);
        const myHand = pileCards(state.piles[`${current}-hand`]);
        const naturals = myHand.filter(
          (c) => !isWild(c) && c.rank === top.rank
        );
        const wilds = myHand.filter(isWild);

        const meldPileBefore = pileCards(state.piles[expectedMeldPile]);
        const hasExistingMeld = meldPileBefore.length > 0;

        if (!canMeetInitialMeldMinimum(state, rulesState, current, top)) {
          return {
            valid: false,
            reason:
              "You do not meet the initial meld minimum to start melding.",
            engineEvents: [],
          };
        }

        let neededFromHand: SimpleCard[] = [];
        if (frozenAgainstMe) {
          if (naturals.length < 2) {
            return {
              valid: false,
              reason: `Discard is frozen: you need two natural cards of rank ${top.rank} to take it.`,
              engineEvents: [],
            };
          }
          neededFromHand = naturals.slice(0, 2);
        } else if (hasExistingMeld) {
          neededFromHand = [];
        } else {
          // Not frozen and starting a meld: need two cards from hand that, with top discard,
          // yield a meld with at least 2 naturals.
          if (naturals.length >= 2) {
            neededFromHand = naturals.slice(0, 2);
          } else if (naturals.length >= 1 && wilds.length >= 1) {
            neededFromHand = [naturals[0], wilds[0]];
          } else {
            return {
              valid: false,
              reason: `You need two cards of rank ${top.rank} (or one + a wild) to meld the top discard and take the pile.`,
              engineEvents: [],
            };
          }
        }

        // Move required hand cards first, then the top discard, then pick up the rest into hand.
        for (const c of neededFromHand) {
          engineEvents.push({
            type: "move-cards",
            fromPileId: `${current}-hand`,
            toPileId: expectedMeldPile,
            cardIds: [c.id],
          });
        }

        engineEvents.push({
          type: "move-cards",
          fromPileId: "discard",
          toPileId: expectedMeldPile,
          cardIds: [top.id],
        });

        const rest = discard.slice(0, discard.length - 1);
        if (rest.length > 0) {
          engineEvents.push({
            type: "move-cards",
            fromPileId: "discard",
            toPileId: `${current}-hand`,
            cardIds: rest.map((c) => c.id) as [number, ...number[]],
          });
        }

        // If a red three was buried in the discard pile (only possible from initial flip),
        // it is laid out but does not draw a replacement.
        const red3sFromDiscard = rest.filter(isRedThree);
        for (const c of red3sFromDiscard) {
          engineEvents.push({
            type: "move-cards",
            fromPileId: `${current}-hand`,
            toPileId: `${myTeam}-red3`,
            cardIds: [c.id],
          });
        }

        // Track meld history
        const entry: MeldHistoryEntry = nextRulesState.meldHistory[current] ?? {
          hasMeldedEver: false,
          hasAddedToExistingMeldEver: false,
        };
        nextRulesState = {
          ...nextRulesState,
          turnPhase: "meld-or-discard",
          tookDiscardThisTurn: true,
          pickedUpFromDiscardCardIds: rest.map((c) => c.id),
          cardsPlayedToMeldsThisTurn: [
            ...nextRulesState.cardsPlayedToMeldsThisTurn,
            top.id,
            ...neededFromHand.map((c) => c.id),
          ],
          meldHistory: {
            ...nextRulesState.meldHistory,
            [current]: {
              hasMeldedEver: true,
              hasAddedToExistingMeldEver:
                entry.hasAddedToExistingMeldEver || hasExistingMeld,
            },
          },
        };
        recomputeDerived(state, nextRulesState, engineEvents);
        return { valid: true, engineEvents };
      }

      // Taking back cards from meld (Unmeld)
      const myTeam = teamFor(current);
      if (
        rulesState.turnPhase === "meld-or-discard" &&
        from.startsWith(`${myTeam}-meld-`) &&
        to === `${current}-hand`
      ) {
        const meldPile = pileCards(state.piles[from]);
        const moving = meldPile.find((c) => c.id === cardId);
        if (!moving) {
          return {
            valid: false,
            reason: "Card not in source pile.",
            engineEvents: [],
          };
        }

        if (!rulesState.cardsPlayedToMeldsThisTurn.includes(cardId)) {
          return {
            valid: false,
            reason: "You can only take back cards you played this turn.",
            engineEvents: [],
          };
        }

        // Apply the move
        engineEvents.push({
          type: "move-cards",
          fromPileId: from,
          toPileId: to,
          cardIds: [cardId],
        });

        // Remove from tracking list
        nextRulesState = {
          ...nextRulesState,
          cardsPlayedToMeldsThisTurn:
            nextRulesState.cardsPlayedToMeldsThisTurn.filter(
              (id) => id !== cardId
            ),
        };

        recomputeDerived(state, nextRulesState, engineEvents);
        return { valid: true, engineEvents };
      }

      // Melding from hand to team meld piles
      if (
        rulesState.turnPhase === "meld-or-discard" &&
        from === `${current}-hand`
      ) {
        // Black threes out meld pile (only legal on the final going-out turn; enforced at end of turn).
        if (to === `${teamFor(current)}-black3-out`) {
          const hand = pileCards(state.piles[`${current}-hand`]);
          const moving = hand.find((c) => c.id === cardId);
          if (!moving) {
            return {
              valid: false,
              reason: "Card not in source pile.",
              engineEvents: [],
            };
          }
          if (!isBlackThree(moving)) {
            return {
              valid: false,
              reason: "Only black threes can be melded to this pile.",
              engineEvents: [],
            };
          }
          engineEvents.push({
            type: "move-cards",
            fromPileId: `${current}-hand`,
            toPileId: to,
            cardIds: [cardId],
          });
          recomputeDerived(state, nextRulesState, engineEvents);
          return { valid: true, engineEvents };
        }

        // Discard to end turn
        if (to === "discard") {
          const hand = pileCards(state.piles[`${current}-hand`] ?? null);
          const moving = hand.find((c) => c.id === cardId);
          if (!moving) {
            return {
              valid: false,
              reason: "Card not in source pile.",
              engineEvents: [],
            };
          }

          // If your team does not yet have a canasta, you are not allowed to go out by discarding your last card.
          const myTeam = teamFor(current);
          if (hand.length === 1 && !teamHasCanasta(state, myTeam)) {
            return {
              valid: false,
              reason: "You must have a canasta to go out.",
              engineEvents: [],
            };
          }

          engineEvents.push({
            type: "move-cards",
            fromPileId: `${current}-hand`,
            toPileId: "discard",
            cardIds: [cardId],
          });

          // Validate meld pile invariants at end of turn.
          const projected = projectPilesAfterEvents(state, engineEvents);
          const afterDiscardState = buildStateFromProjected(state, projected);
          const boardError = checkBoardValidity(
            afterDiscardState,
            myTeam,
            rulesState,
            current
          );

          if (boardError) {
            // Map common prose errors to codes for AI
            let code = "COMMIT_REJECTED";
            if (boardError.includes("three")) code = "MELD_TOO_SMALL";
            if (boardError.includes("Initial")) code = "INITIAL_MELD_TOO_LOW";
            if (boardError.includes("canasta"))
              code = "NO_CANASTA_CANNOT_GO_OUT";

            // Record it in our local agentGuide for the next turn
            nextRulesState.agentGuide = {
              ...(nextRulesState.agentGuide ?? {}),
              lastRejection: { code },
            };

            return {
              valid: false,
              reason: boardError,
              engineEvents: [],
            };
          }

          const afterHand = projected[`${current}-hand`];
          const wentOut = (afterHand?.size ?? 0) === 0;
          const turnDigest = formatTurnDigest(
            current,
            nextRulesState,
            moving,
            wentOut
          );
          nextRulesState.agentGuide = {
            ...appendHistoryDigest(nextRulesState.agentGuide, turnDigest),
            lastRejection: null,
          };
          // Black threes meld is only legal as part of going out.
          if (!wentOut) {
            const black3Out = projected[`${myTeam}-black3-out`]?.cardIds ?? [];
            if (black3Out.length > 0) {
              return {
                valid: false,
                reason: "Black threes can only be melded when going out.",
                engineEvents: [],
              };
            }
          }
          if (wentOut) {
            if (!teamHasCanasta(state, myTeam)) {
              // Note: completing the canasta and going out on same turn is allowed; check after projected.
              const handEndStateAfterDiscardCheck = buildStateFromProjected(
                state,
                projected
              );
              if (!teamHasCanasta(handEndStateAfterDiscardCheck, myTeam)) {
                return {
                  valid: false,
                  reason: "You must have a canasta to go out.",
                  engineEvents: [],
                };
              }
            }

            const handEndState = buildStateFromProjected(state, projected);

            const concealed = !rulesState.turnStartTeamHadMeld[myTeam];
            const handScore = computeHandScore(
              handEndState,
              myTeam,
              concealed ? myTeam : null
            );
            const updatedGameScore: Record<Team, number> = {
              A: (rulesState.gameScore.A ?? 0) + (handScore.A ?? 0),
              B: (rulesState.gameScore.B ?? 0) + (handScore.B ?? 0),
            };

            const winner =
              updatedGameScore.A >= 5000 || updatedGameScore.B >= 5000
                ? updatedGameScore.A === updatedGameScore.B
                  ? "Tie"
                  : updatedGameScore.A > updatedGameScore.B
                    ? "Team A (P1 & P3)"
                    : "Team B (P2 & P4)"
                : null;

            nextRulesState = {
              ...nextRulesState,
              phase: winner ? "ended" : "setup",
              hasDealt: false,
              dealerIndex: (rulesState.dealerIndex + 1) % 4,
              gameScore: updatedGameScore,
              lastHandScore: handScore,
              turnPhase: "must-draw",
              tookDiscardThisTurn: false,
              pickedUpFromDiscardCardIds: [],
              result: `Hand ${rulesState.dealNumber} Result: ${current} went out. Team A: ${handScore.A}, Team B: ${handScore.B}.`,
            };

            // Gather cards back to deck for next round
            engineEvents.push(
              ...gatherAllCards(state, { previousEvents: engineEvents })
            );

            engineEvents.push({ type: "set-current-player", player: null });
            if (winner) engineEvents.push({ type: "set-winner", winner });
            recomputeDerived(state, nextRulesState, engineEvents);
            return { valid: true, engineEvents };
          }

          // Normal turn end: advance player, reset per-turn flags.
          const finalHandStateAfterDiscard = buildStateFromProjected(
            state,
            projected
          );
          nextRulesState = {
            ...nextRulesState,
            turnPhase: "must-draw",
            tookDiscardThisTurn: false,
            pickedUpFromDiscardCardIds: [],
            turnStartTeamHadMeld: {
              A: teamHasAnyMeld(finalHandStateAfterDiscard, "A"),
              B: teamHasAnyMeld(finalHandStateAfterDiscard, "B"),
            },
          };
          engineEvents.push({
            type: "set-current-player",
            player: nextPlayerClockwise(current),
          });
          recomputeDerived(state, nextRulesState, engineEvents);
          return { valid: true, engineEvents };
        }

        // Move to meld piles (team piles only)
        const myTeam = teamFor(current);
        const allowedPrefix = `${myTeam}-meld-`;
        if (!to.startsWith(allowedPrefix)) {
          return {
            valid: false,
            reason: `You can only meld to your partnership's (Team ${myTeam}) meld piles.`,
            engineEvents: [],
          };
        }

        const targetRank = to.replace(allowedPrefix, "");
        if (!isNaturalMeldRank(targetRank)) {
          return {
            valid: false,
            reason: `Invalid meld pile rank: ${targetRank}.`,
            engineEvents: [],
          };
        }

        const hand = pileCards(state.piles[`${current}-hand`] ?? null);
        const moving = hand.find((c) => c.id === cardId);
        if (!moving) {
          return {
            valid: false,
            reason: "Card not in source pile.",
            engineEvents: [],
          };
        }
        if (isRedThree(moving)) {
          return {
            valid: false,
            reason: `Red threes (${formatCard(moving.rank, moving.suit)}) are laid out automatically.`,
            engineEvents: [],
          };
        }
        if (isBlackThree(moving)) {
          return {
            valid: false,
            reason: `Black threes (${formatCard(moving.rank, moving.suit)}) can only be melded (sets of 3 or 4) when you are going out.`,
            engineEvents: [],
          };
        }
        if (!canMeetInitialMeldMinimum(state, rulesState, current, moving)) {
          return {
            valid: false,
            reason:
              "You do not meet the initial meld minimum to start melding.",
            engineEvents: [],
          };
        }
        const meldGuardrailError = canStartOrExtendMeld(
          state,
          current,
          to,
          moving
        );
        if (meldGuardrailError) {
          return { valid: false, reason: meldGuardrailError, engineEvents: [] };
        }

        // Apply the move
        engineEvents.push({
          type: "move-cards",
          fromPileId: `${current}-hand`,
          toPileId: to,
          cardIds: [cardId],
        });

        // Track that we played this card this turn
        nextRulesState = {
          ...nextRulesState,
          cardsPlayedToMeldsThisTurn: [
            ...nextRulesState.cardsPlayedToMeldsThisTurn,
            cardId,
          ],
        };

        // Validate target pile constraints immediately (no wrong ranks, max wilds, min naturals if non-empty).
        const projected = projectPilesAfterEvents(state, engineEvents);
        const targetPileCards = projected[to]?.cards ?? [];
        const err = validateMeldPileContents(
          targetPileCards,
          targetRank,
          false
        );
        if (err) {
          return { valid: false, reason: err, engineEvents: [] };
        }

        // Track meld history (for future concealed support and debugging)
        const before = pileCards(state.piles[to] ?? null);
        const entry: MeldHistoryEntry = nextRulesState.meldHistory[current] ?? {
          hasMeldedEver: false,
          hasAddedToExistingMeldEver: false,
        };
        nextRulesState = {
          ...nextRulesState,
          meldHistory: {
            ...nextRulesState.meldHistory,
            [current]: {
              hasMeldedEver: true,
              hasAddedToExistingMeldEver:
                entry.hasAddedToExistingMeldEver || before.length > 0,
            },
          },
        };

        recomputeDerived(state, nextRulesState, engineEvents);
        return { valid: true, engineEvents };
      }

      return {
        valid: false,
        reason: "Illegal move for current phase.",
        engineEvents: [],
      };
    }

    return { valid: false, reason: "Unsupported intent.", engineEvents: [] };
  },
};

export const canastaPlugin: GamePlugin = {
  id: "canasta",
  gameName: META.gameName,
  ruleModule: canastaRules,
  description: META.description,
  validationHints: (() => {
    const hints: ValidationHints = {
      // Rules need to enumerate the deck for dealing/drawing and the public discard/meld piles.
      sharedPileIds: [
        "deck",
        "discard",
        "A-red3",
        "B-red3",
        "A-black3-out",
        "B-black3-out",
        ...allMeldPileIdsForTeam("A"),
        ...allMeldPileIdsForTeam("B"),
      ],
      // Hand visibility: Rules can see all hands.
      isPileAlwaysVisibleToRules: (pid) => pid.endsWith("-hand"),
    };
    return hints;
  })(),
};
