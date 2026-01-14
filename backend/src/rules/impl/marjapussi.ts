/**
 * Marjapussi (original scoring, 4-player partnerships).
 *
 * Implements marriages/trump declarations, compulsory overtake rules,
 * and game-point scoring to exactly 10.
 */
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
  ActionCell,
  ActionGrid,
  ClientIntent,
  Scoreboard,
} from "../../../../shared/schemas.js";
import {
  EngineEvent,
  ValidationResult,
} from "../../../../shared/validation.js";
import { loadGameMeta } from "../meta.js";
import { getSuitSymbol } from "../../util/card-notation.js";
import { projectPilesAfterEvents, type ProjectedPiles } from "../util/piles.js";
import {
  gatherAllCards,
  shuffleAllCards,
  distributeRoundRobin,
} from "../util/dealing.js";

const META = loadGameMeta("marjapussi");

const PLAYERS = ["N", "E", "S", "W"] as const;
const TEAM_NS_WON = "TEAM-NS-WON";
const TEAM_EW_WON = "TEAM-EW-WON";
const SUITS = ["clubs", "diamonds", "hearts", "spades"] as const;

type Suit = (typeof SUITS)[number];
type Partnership = "NS" | "EW";
type Phase = "setup" | "play" | "game-over";
type Rank = "6" | "7" | "8" | "9" | "J" | "Q" | "K" | "10" | "A";

interface PlayedCard {
  cardId: number;
  player: string;
  suit: Suit;
  rank: Rank;
}

interface MarriageEntry {
  suit: Suit;
  team: Partnership;
  points: number;
}

interface MarjapussiRulesState {
  hasDealt: boolean;
  phase: Phase;
  dealNumber: number;
  dealerIndex: number;
  trickNumber: number;
  trickLeader: string | null;
  currentTrick: { cards: PlayedCard[]; leadSuit: Suit | null };
  trumpSuit: Suit | null;
  marriages: MarriageEntry[];
  gamePoints: Record<Partnership, number>;
  marriagePoints: Record<Partnership, number>; // Points from marriages in the CURRENT hand
  inTheBag: Record<Partnership, boolean>; // Whether team is currently "pussissa"
  lastTrickWinner: string | null;
  canDeclare: boolean;
  result: string | null;
}

const TRICK_RANK_VALUE: Record<string, number> = {
  "6": 1,
  "7": 2,
  "8": 3,
  "9": 4,
  J: 5,
  Q: 6,
  K: 7,
  "10": 8,
  A: 9,
};

const CARD_POINT_VALUE: Record<string, number> = {
  A: 11,
  "10": 10,
  K: 4,
  Q: 3,
  J: 2,
  "9": 0,
  "8": 0,
  "7": 0,
  "6": 0,
};

function partnershipFor(playerId: string | null): Partnership {
  if (playerId === "N" || playerId === "S") return "NS";
  return "EW";
}

function partnerOf(playerId: string): string {
  switch (playerId) {
    case "N":
      return "S";
    case "S":
      return "N";
    case "E":
      return "W";
    case "W":
    default:
      return "E";
  }
}

function nextPlayerId(playerId: string): string {
  const idx = PLAYERS.indexOf(playerId as (typeof PLAYERS)[number]);
  if (idx === -1) return PLAYERS[0];
  return PLAYERS[(idx + 1) % PLAYERS.length];
}

function rankValueForTrick(rank: string): number {
  return TRICK_RANK_VALUE[rank] ?? 0;
}

function cardPointValue(rank: string): number {
  return CARD_POINT_VALUE[rank] ?? 0;
}

function getRulesState(raw: unknown): MarjapussiRulesState {
  const base: MarjapussiRulesState = {
    hasDealt: false,
    phase: "setup",
    dealNumber: 0,
    dealerIndex: 0,
    trickNumber: 1,
    trickLeader: null,
    currentTrick: { cards: [], leadSuit: null },
    trumpSuit: null,
    marriages: [],
    gamePoints: { NS: 0, EW: 0 },
    marriagePoints: { NS: 0, EW: 0 },
    inTheBag: { NS: false, EW: false },
    lastTrickWinner: null,
    canDeclare: false,
    result: null,
  };

  if (!raw || typeof raw !== "object") {
    return base;
  }

  const obj = raw as Partial<MarjapussiRulesState>;
  const leadSuit =
    obj.currentTrick &&
    typeof obj.currentTrick === "object" &&
    "leadSuit" in obj.currentTrick
      ? ((obj.currentTrick as { leadSuit?: Suit | null }).leadSuit ?? null)
      : null;

  const currentTrick =
    obj.currentTrick && typeof obj.currentTrick === "object"
      ? {
          cards: Array.isArray(obj.currentTrick.cards)
            ? obj.currentTrick.cards
            : [],
          leadSuit,
        }
      : base.currentTrick;

  return {
    ...base,
    ...obj,
    currentTrick,
    marriages: Array.isArray(obj.marriages) ? obj.marriages : base.marriages,
    gamePoints: obj.gamePoints ?? base.gamePoints,
    marriagePoints: obj.marriagePoints ?? base.marriagePoints,
    inTheBag: obj.inTheBag ?? base.inTheBag,
    phase: (obj.phase as Phase) ?? base.phase,
    result: obj.result ?? base.result,
  };
}

function buildRankLookup(
  state: ValidationState
): Record<number, { rank: string; suit: string }> {
  const lookup: Record<number, { rank: string; suit: string }> = {};
  for (const pile of Object.values(state.piles)) {
    if (!pile.cards) continue;
    for (const card of pile.cards) {
      if (typeof card.id !== "number") continue;
      lookup[card.id] = { rank: card.rank, suit: card.suit };
    }
  }
  return lookup;
}

function pileCards(pile?: ValidationPileSummary | null): PlayedCard[] {
  if (!pile || !pile.cards) return [];
  return pile.cards
    .map((c) => {
      if (
        typeof c.id !== "number" ||
        typeof c.rank !== "string" ||
        typeof c.suit !== "string"
      ) {
        return null;
      }
      const rank = c.rank as Rank;
      const suit = c.suit as Suit;
      return { cardId: c.id, player: pile.ownerId ?? "", suit, rank };
    })
    .filter((c): c is PlayedCard => Boolean(c && c.rank && c.suit));
}

function canCardBeat(
  card: PlayedCard,
  currentWinner: PlayedCard,
  leadSuit: Suit | null,
  trumpSuit: Suit | null
): boolean {
  const isTrump = trumpSuit ? card.suit === trumpSuit : false;
  const winnerIsTrump = trumpSuit ? currentWinner.suit === trumpSuit : false;

  if (isTrump && !winnerIsTrump) return true;
  if (!isTrump && winnerIsTrump) return false;

  if (winnerIsTrump && isTrump) {
    return rankValueForTrick(card.rank) > rankValueForTrick(currentWinner.rank);
  }

  const lead = leadSuit ?? currentWinner.suit;
  if (lead && card.suit !== lead) return false;
  return rankValueForTrick(card.rank) > rankValueForTrick(currentWinner.rank);
}

function winningCard(
  trick: PlayedCard[],
  leadSuit: Suit | null,
  trumpSuit: Suit | null
): PlayedCard | null {
  if (trick.length === 0) return null;
  const lead = leadSuit ?? trick[0]?.suit ?? null;
  let winner = trick[0];
  for (const card of trick.slice(1)) {
    if (canCardBeat(card, winner, lead, trumpSuit)) {
      winner = card;
    }
  }
  return winner;
}

function allowedCardsForPlay(
  hand: PlayedCard[],
  trick: PlayedCard[],
  leadSuit: Suit | null,
  trumpSuit: Suit | null
): PlayedCard[] {
  if (trick.length === 0) {
    return hand;
  }

  const lead = leadSuit ?? trick[0]?.suit ?? null;
  const leadSuitCards = lead ? hand.filter((c) => c.suit === lead) : [];

  if (leadSuitCards.length > 0) {
    return leadSuitCards;
  }

  // MUST trump if void in led suit
  const trumps = trumpSuit ? hand.filter((c) => c.suit === trumpSuit) : [];
  if (trumps.length > 0) {
    return trumps;
  }

  return hand;
}

function calculateCardPoints(
  projected: ProjectedPiles,
  rankLookup: Record<number, { rank: string; suit: string }>
): Record<Partnership, number> {
  const totals: Record<Partnership, number> = { NS: 0, EW: 0 };
  const teamToPile: Record<Partnership, string> = {
    NS: TEAM_NS_WON,
    EW: TEAM_EW_WON,
  };

  for (const team of ["NS", "EW"] as Partnership[]) {
    const pile = projected[teamToPile[team]];
    if (!pile) continue;
    const ids = pile.cardIds ?? [];
    for (const id of ids) {
      const info = rankLookup[id];
      if (!info) continue;
      totals[team] += cardPointValue(info.rank);
    }
  }

  return totals;
}

function winnerText(gamePoints: Record<Partnership, number>): string | null {
  const ns = gamePoints.NS ?? 0;
  const ew = gamePoints.EW ?? 0;
  if (ns >= 12 && ew >= 12) {
    if (ns > ew) return "Team NS (North & South)";
    if (ew > ns) return "Team EW (East & West)";
    return "Tie at " + ns;
  }
  if (ns >= 12) return "Team NS (North & South)";
  if (ew >= 12) return "Team EW (East & West)";
  return null;
}

function suitsDeclaredByAny(rulesState: MarjapussiRulesState): Set<Suit> {
  return new Set(rulesState.marriages.map((m) => m.suit));
}

function hasFullMarriage(hand: PlayedCard[], suit: Suit): boolean {
  const ranks = hand.filter((c) => c.suit === suit).map((c) => c.rank);
  return ranks.includes("K") && ranks.includes("Q");
}

function recordMarriage(
  rulesState: MarjapussiRulesState,
  suit: Suit,
  team: Partnership
): MarjapussiRulesState {
  if (rulesState.inTheBag[team]) return rulesState;

  const isFirst = rulesState.marriages.length === 0;
  const points = isFirst ? 40 : 20;

  const nextMarriagePoints = { ...rulesState.marriagePoints };
  nextMarriagePoints[team] += points;

  const newEntry: MarriageEntry = { suit, team, points };

  return {
    ...rulesState,
    trumpSuit: suit,
    marriages: [...rulesState.marriages, newEntry],
    marriagePoints: nextMarriagePoints,
  };
}

function legalDeclarationIntents(
  state: ValidationState,
  rulesState: MarjapussiRulesState,
  playerId: string
): ClientIntent[] {
  if (!rulesState.canDeclare) return [];
  if (rulesState.currentTrick.cards.length !== 0) return [];
  if (state.currentPlayer !== playerId) return [];

  const team = partnershipFor(playerId);
  if (rulesState.inTheBag[team]) return [];

  const gameId = state.gameId;
  const intents: ClientIntent[] = [];
  const hand = pileCards(state.piles[`${playerId}-hand`]);
  const partnerId = partnerOf(playerId);
  const partnerHand = pileCards(state.piles[`${partnerId}-hand`]);
  const declared = suitsDeclaredByAny(rulesState);

  for (const suit of SUITS) {
    if (declared.has(suit)) continue;
    if (hasFullMarriage(hand, suit)) {
      intents.push({
        type: "action",
        gameId,
        playerId,
        action: `declare-marriage-self-${suit}`,
      });
    }
    if (hasFullMarriage(partnerHand, suit)) {
      intents.push({
        type: "action",
        gameId,
        playerId,
        action: `declare-marriage-partner-${suit}`,
      });
    }
  }

  return intents;
}

function deriveActions(
  state: ValidationState,
  rulesState: MarjapussiRulesState,
  currentPlayer: string | null
): ActionGrid {
  if (
    state.winner ||
    rulesState.phase === "game-over" ||
    !rulesState.hasDealt
  ) {
    return { rows: 0, cols: 0, cells: [] };
  }

  if (
    !currentPlayer ||
    !rulesState.canDeclare ||
    rulesState.currentTrick.cards.length !== 0
  ) {
    return { rows: 0, cols: 0, cells: [] };
  }

  const intents = legalDeclarationIntents(state, rulesState, currentPlayer);
  if (intents.length === 0) {
    return { rows: 0, cols: 0, cells: [] };
  }

  const cells: ActionCell[] = [];
  let row = 0;
  let col = 0;
  for (const intent of intents) {
    if (intent.type !== "action") continue;
    let label = intent.action;
    if (intent.action.startsWith("declare-marriage-self-")) {
      const suit = intent.action.replace("declare-marriage-self-", "");
      label = `Declare marriage (${getSuitSymbol(suit)})`;
    } else if (intent.action.startsWith("declare-marriage-partner-")) {
      const suit = intent.action.replace("declare-marriage-partner-", "");
      label = `Declare partner's marriage (${getSuitSymbol(suit)})`;
    }

    cells.push({
      id: intent.action,
      label,
      enabled: true,
      row,
      col,
    });
    col++;
    if (col >= 2) {
      col = 0;
      row++;
    }
  }

  const maxRow = Math.max(...cells.map((c) => c.row), 0);
  const maxCol = Math.max(...cells.map((c) => c.col), 1);

  return {
    rows: maxRow + 1,
    cols: Math.max(maxCol + 1, 2),
    cells,
  };
}

function deriveScoreboards(
  state: ValidationState,
  rulesState: MarjapussiRulesState,
  engineEvents: EngineEvent[]
): Scoreboard[] {
  const projected = projectPilesAfterEvents(state, engineEvents);
  const rankLookup = buildRankLookup(state);
  const cardPoints = calculateCardPoints(projected, rankLookup);
  const tricks: Record<Partnership, number> = {
    NS: Math.floor((projected[TEAM_NS_WON]?.size ?? 0) / 4),
    EW: Math.floor((projected[TEAM_EW_WON]?.size ?? 0) / 4),
  };

  const marriageSummary = (team: Partnership): string => {
    const entries = rulesState.marriages.filter((m) => m.team === team);
    if (entries.length === 0) return "-";
    return entries
      .map((m) => `${getSuitSymbol(m.suit)} (+${m.points})`)
      .join(", ");
  };

  const bagStatus = (team: Partnership): string => {
    return rulesState.inTheBag[team] ? " (PUSSISSA)" : "";
  };

  const cells: Scoreboard["cells"] = [
    { row: 0, col: 0, text: "Team", role: "header", align: "left" },
    { row: 0, col: 1, text: "Game pts", role: "header", align: "right" },
    { row: 0, col: 2, text: "Hand pts", role: "header", align: "right" },
    { row: 0, col: 3, text: "Marriages", role: "header", align: "left" },
    {
      row: 1,
      col: 0,
      text: `Team NS (N, S)${bagStatus("NS")}`,
      role: "header",
      align: "left",
    },
    {
      row: 1,
      col: 1,
      text: String(rulesState.gamePoints.NS ?? 0),
      align: "right",
    },
    {
      row: 1,
      col: 2,
      text: String(cardPoints.NS + rulesState.marriagePoints.NS),
      align: "right",
    },
    { row: 1, col: 3, text: marriageSummary("NS"), align: "left" },
    {
      row: 2,
      col: 0,
      text: `Team EW (E, W)${bagStatus("EW")}`,
      role: "header",
      align: "left",
    },
    {
      row: 2,
      col: 1,
      text: String(rulesState.gamePoints.EW ?? 0),
      align: "right",
    },
    {
      row: 2,
      col: 2,
      text: String(cardPoints.EW + rulesState.marriagePoints.EW),
      align: "right",
    },
    { row: 2, col: 3, text: marriageSummary("EW"), align: "left" },
  ];

  const metaRow = 3;
  const trumpLabel = rulesState.trumpSuit
    ? getSuitSymbol(rulesState.trumpSuit)
    : "None";
  const trickLabel =
    rulesState.phase === "setup" ? "-" : String(rulesState.trickNumber);
  const dealLabel =
    rulesState.dealNumber > 0 ? String(rulesState.dealNumber) : "-";

  cells.push(
    { row: metaRow, col: 0, text: `Deal: ${dealLabel}`, align: "left" },
    { row: metaRow, col: 1, text: `Trick: ${trickLabel}`, align: "left" },
    { row: metaRow, col: 2, text: `Trumps: ${trumpLabel}`, align: "left" },
    {
      row: metaRow,
      col: 3,
      text: `Tricks NS/EW: ${tricks.NS}/${tricks.EW}`,
      align: "right",
    }
  );

  return [
    {
      id: "marjapussi-main",
      title: "Marjapussi",
      rows: metaRow + 1,
      cols: 4,
      cells,
    },
  ];
}

function buildDeal(
  state: ValidationState,
  rulesState: MarjapussiRulesState
): {
  events: EngineEvent[];
  nextRulesState: MarjapussiRulesState;
  nextPlayer: string;
} | null {
  const nextDealNumber = rulesState.dealNumber + 1;

  // Gather all cards back to deck
  const events: EngineEvent[] = gatherAllCards(state);

  // Reset all hand visibilities to owner-only for the next deal
  for (const player of PLAYERS) {
    events.push({
      type: "set-pile-visibility",
      pileId: `${player}-hand`,
      visibility: "owner",
    });
  }

  // SHUFFLE all cards deterministically
  const shuffled = shuffleAllCards(state, nextDealNumber, "MARJAPUSSI");

  // Deal 9 each
  const { events: dealEvents } = distributeRoundRobin(
    shuffled,
    PLAYERS.map((p) => `${p}-hand`),
    9
  );
  events.push(...dealEvents);

  const dealerIndex = rulesState.dealerIndex % PLAYERS.length;
  const leader = PLAYERS[(dealerIndex + 1) % PLAYERS.length];

  const nextRulesState: MarjapussiRulesState = {
    ...rulesState,
    hasDealt: true,
    phase: "play",
    dealNumber: nextDealNumber,
    trickNumber: 1,
    trickLeader: leader,
    currentTrick: { cards: [], leadSuit: null },
    trumpSuit: null,
    marriages: [],
    marriagePoints: { NS: 0, EW: 0 },
    lastTrickWinner: null,
    canDeclare: true,
  };

  return { events, nextRulesState, nextPlayer: leader };
}

function finishHand(
  state: ValidationState,
  rulesState: MarjapussiRulesState,
  engineEvents: EngineEvent[],
  lastTrickWinner: string
): {
  nextRulesState: MarjapussiRulesState;
  winner: string | null;
  nextPlayer: string | null;
} {
  const rankLookup = buildRankLookup(state);
  const projected = projectPilesAfterEvents(state, engineEvents);
  const cardPoints = calculateCardPoints(projected, rankLookup);

  // Last trick is worth 10 points
  const lastTrickTeam = partnershipFor(lastTrickWinner);
  cardPoints[lastTrickTeam] += 10;

  const tricksWon: Record<Partnership, number> = {
    NS: Math.floor((projected[TEAM_NS_WON]?.size ?? 0) / 4),
    EW: Math.floor((projected[TEAM_EW_WON]?.size ?? 0) / 4),
  };

  const totalPoints: Record<Partnership, number> = {
    NS: cardPoints.NS + rulesState.marriagePoints.NS,
    EW: cardPoints.EW + rulesState.marriagePoints.EW,
  };

  const nextGamePoints = { ...rulesState.gamePoints };
  const nextInTheBag = { ...rulesState.inTheBag };

  let handWinner: Partnership | null = null;
  if (totalPoints.NS > totalPoints.EW) {
    if (!rulesState.inTheBag.NS) handWinner = "NS";
  } else if (totalPoints.EW > totalPoints.NS) {
    if (!rulesState.inTheBag.EW) handWinner = "EW";
  }

  if (handWinner) {
    const loser = handWinner === "NS" ? "EW" : "NS";
    const gp = totalPoints[loser] < 20 ? 2 : 1;
    nextGamePoints[handWinner] += gp;
  }

  // Update Bag status for NEXT hand
  nextInTheBag.NS = tricksWon.NS === 0;
  nextInTheBag.EW = tricksWon.EW === 0;

  const updated: MarjapussiRulesState = {
    ...rulesState,
    hasDealt: false,
    phase: "setup",
    trumpSuit: null,
    marriages: [],
    marriagePoints: { NS: 0, EW: 0 },
    currentTrick: { cards: [], leadSuit: null },
    trickLeader: null,
    trickNumber: 1,
    lastTrickWinner,
    canDeclare: false,
    gamePoints: nextGamePoints,
    inTheBag: nextInTheBag,
    dealerIndex: (rulesState.dealerIndex + 1) % PLAYERS.length,
    result: `Hand ${rulesState.dealNumber} Result: Team NS ${totalPoints.NS} pts, Team EW ${totalPoints.EW} pts.`,
  };

  const winnerStr = winnerText(nextGamePoints);
  if (winnerStr) {
    updated.phase = "game-over";
  }

  const nextPlayer = winnerStr ? null : PLAYERS[updated.dealerIndex];
  return { nextRulesState: updated, winner: winnerStr, nextPlayer };
}

const marjapussiRuleModule: GameRuleModule = {
  listLegalIntentsForPlayer(
    state: ValidationState,
    playerId: string
  ): ClientIntent[] {
    const rulesState = getRulesState(state.rulesState);
    const intents: ClientIntent[] = [];
    const gameId = state.gameId;

    if (state.winner || rulesState.phase === "game-over") {
      return intents;
    }

    const candidates: ClientIntent[] = [];

    if (!rulesState.hasDealt) {
      candidates.push({
        type: "action",
        gameId,
        playerId,
        action: "start-game",
      });
    } else {
      // Moves
      const hand = state.piles[`${playerId}-hand`];
      if (hand && hand.cards) {
        for (const card of hand.cards) {
          candidates.push({
            type: "move",
            gameId,
            playerId,
            fromPileId: `${playerId}-hand`,
            toPileId: "trick",
            cardId: card.id,
          });
        }
      }

      // Declarations
      for (const suit of SUITS) {
        candidates.push({
          type: "action",
          gameId,
          playerId,
          action: `declare-marriage-self-${suit}`,
        });
        candidates.push({
          type: "action",
          gameId,
          playerId,
          action: `declare-marriage-partner-${suit}`,
        });
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

    if (state.winner || rulesState.phase === "game-over") {
      return {
        valid: false,
        reason: "Game is already finished.",
        engineEvents: [],
      };
    }

    // Start / redeal
    if (intent.type === "action" && intent.action === "start-game") {
      if (rulesState.hasDealt && rulesState.phase === "play") {
        return {
          valid: false,
          reason: "Current hand is still in progress.",
          engineEvents: [],
        };
      }

      const dealResult = buildDeal(state, rulesState);
      if (!dealResult) {
        return {
          valid: false,
          reason: "Cannot start deal: missing cards.",
          engineEvents: [],
        };
      }

      engineEvents.push(...dealResult.events);
      engineEvents.push({
        type: "set-current-player",
        player: dealResult.nextPlayer,
      });
      const nextRulesState = dealResult.nextRulesState;
      engineEvents.push({
        type: "set-rules-state",
        rulesState: nextRulesState,
      });

      const actions = deriveActions(
        state,
        nextRulesState,
        dealResult.nextPlayer
      );
      const scoreboards = deriveScoreboards(
        state,
        nextRulesState,
        engineEvents
      );

      engineEvents.push({ type: "set-actions", actions });
      engineEvents.push({ type: "set-scoreboards", scoreboards });

      return { valid: true, engineEvents };
    }

    if (!rulesState.hasDealt || rulesState.phase !== "play") {
      return {
        valid: false,
        reason: "Start the deal first.",
        engineEvents: [],
      };
    }

    if (
      !intent.playerId ||
      !PLAYERS.includes(intent.playerId as (typeof PLAYERS)[number])
    ) {
      return {
        valid: false,
        reason: `Player ${intent.playerId ?? "unknown"} is not recognized in Marjapussi.`,
        engineEvents: [],
      };
    }

    // Declaration actions
    if (intent.type === "action" && intent.action !== "start-game") {
      if (
        !rulesState.canDeclare ||
        rulesState.currentTrick.cards.length !== 0
      ) {
        return {
          valid: false,
          reason:
            "Declarations are only allowed at the start of your turn to lead.",
          engineEvents: [],
        };
      }

      if (state.currentPlayer !== intent.playerId) {
        return {
          valid: false,
          reason: `It is currently ${state.currentPlayer}'s turn to lead and declare.`,
          engineEvents: [],
        };
      }

      const playerId = intent.playerId;
      const team = partnershipFor(playerId);
      if (rulesState.inTheBag[team]) {
        return {
          valid: false,
          reason:
            "Your team is 'in the bag' (pussissa) and cannot declare marriages until you win a trick.",
          engineEvents: [],
        };
      }

      const declared = suitsDeclaredByAny(rulesState);
      let nextRulesState = { ...rulesState };
      let declaredMarriageSuit: Suit | null = null;

      if (intent.action.startsWith("declare-marriage-self-")) {
        const suitStr = intent.action.replace("declare-marriage-self-", "");
        if (!SUITS.includes(suitStr as Suit)) {
          return {
            valid: false,
            reason: `Unknown suit: ${suitStr}.`,
            engineEvents: [],
          };
        }
        const suit = suitStr as Suit;
        if (declared.has(suit)) {
          return {
            valid: false,
            reason: `The marriage in ${getSuitSymbol(suit)} has already been declared.`,
            engineEvents: [],
          };
        }
        const hand = pileCards(state.piles[`${playerId}-hand`]);
        if (!hasFullMarriage(hand, suit)) {
          return {
            valid: false,
            reason: `You do not have both the King and Queen of ${getSuitSymbol(suit)}.`,
            engineEvents: [],
          };
        }

        nextRulesState = recordMarriage(nextRulesState, suit, team);
        declaredMarriageSuit = suit;
      } else if (intent.action.startsWith("declare-marriage-partner-")) {
        const suitStr = intent.action.replace("declare-marriage-partner-", "");
        if (!SUITS.includes(suitStr as Suit)) {
          return {
            valid: false,
            reason: `Unknown suit: ${suitStr}.`,
            engineEvents: [],
          };
        }
        const suit = suitStr as Suit;
        if (declared.has(suit)) {
          return {
            valid: false,
            reason: `The marriage in ${getSuitSymbol(suit)} has already been declared.`,
            engineEvents: [],
          };
        }
        const partnerId = partnerOf(playerId);
        const partnerHand = pileCards(state.piles[`${partnerId}-hand`]);
        if (!hasFullMarriage(partnerHand, suit)) {
          return {
            valid: false,
            reason: `Your partner does not have both the King and Queen of ${getSuitSymbol(suit)}.`,
            engineEvents: [],
          };
        }

        nextRulesState = recordMarriage(nextRulesState, suit, team);
        declaredMarriageSuit = suit;
      } else {
        return {
          valid: false,
          reason: `Unknown action: ${intent.action}.`,
          engineEvents: [],
        };
      }

      const winner = winnerText(nextRulesState.gamePoints);
      if (winner) {
        nextRulesState = { ...nextRulesState, phase: "game-over" };
      }

      if (declaredMarriageSuit) {
        engineEvents.push({
          type: "announce",
          text: `${playerId} declared marriage in ${getSuitSymbol(declaredMarriageSuit)}`,
          anchor: { type: "screen" },
        });
      }

      engineEvents.push({
        type: "set-rules-state",
        rulesState: nextRulesState,
      });
      const actions = deriveActions(state, nextRulesState, state.currentPlayer);
      const scoreboards = deriveScoreboards(
        state,
        nextRulesState,
        engineEvents
      );
      engineEvents.push({ type: "set-actions", actions });
      engineEvents.push({ type: "set-scoreboards", scoreboards });

      if (winner) {
        engineEvents.push({ type: "set-winner", winner });
      }

      return { valid: true, engineEvents };
    }

    // Card play
    if (intent.type !== "move") {
      return {
        valid: false,
        reason: "Marjapussi does not support drawing cards.",
        engineEvents: [],
      };
    }

    const playerId = intent.playerId;
    if (state.currentPlayer !== playerId) {
      return {
        valid: false,
        reason: `It is currently ${state.currentPlayer}'s turn.`,
        engineEvents: [],
      };
    }

    const fromPileId = `${playerId}-hand`;
    if (intent.fromPileId !== fromPileId || intent.toPileId !== "trick") {
      return {
        valid: false,
        reason: "You can only play cards from your hand to the trick.",
        engineEvents: [],
      };
    }

    const handPile = state.piles[fromPileId];
    if (!handPile || !handPile.cards) {
      return {
        valid: false,
        reason: "Hand not available.",
        engineEvents: [],
      };
    }

    if (intent.cardId! === undefined) {
      return {
        valid: false,
        reason: "Move requires cardId.",
        engineEvents: [],
      };
    }

    // Engine guarantees card exists in source pile
    const played = handPile.cards.find((c) => c.id === intent.cardId!)!;

    const handCards = pileCards(handPile);
    const lead =
      rulesState.currentTrick.leadSuit ??
      rulesState.currentTrick.cards[0]?.suit ??
      null;
    const leadSuitCards = lead ? handCards.filter((c) => c.suit === lead) : [];
    const trumps = rulesState.trumpSuit
      ? handCards.filter((c) => c.suit === rulesState.trumpSuit)
      : [];

    if (leadSuitCards.length > 0 && played.suit !== lead && lead !== null) {
      return {
        valid: false,
        reason: `You must follow suit: ${getSuitSymbol(lead)}.`,
        engineEvents: [],
      };
    }

    if (
      lead !== null &&
      leadSuitCards.length === 0 &&
      trumps.length > 0 &&
      played.suit !== rulesState.trumpSuit &&
      rulesState.trumpSuit !== null
    ) {
      return {
        valid: false,
        reason: `You must play a trump: ${getSuitSymbol(rulesState.trumpSuit)}.`,
        engineEvents: [],
      };
    }

    const allowedCards = allowedCardsForPlay(
      handCards,
      rulesState.currentTrick.cards,
      rulesState.currentTrick.leadSuit,
      rulesState.trumpSuit
    );
    if (!allowedCards.some((c) => c.cardId === intent.cardId!)) {
      return {
        valid: false,
        reason: "That card is not legal now.",
        engineEvents: [],
      };
    }

    const playedCard: PlayedCard = {
      cardId: intent.cardId!,
      player: playerId,
      suit: played.suit as Suit,
      rank: played.rank as Rank,
    };

    engineEvents.push({
      type: "move-cards",
      fromPileId,
      toPileId: "trick",
      cardIds: [intent.cardId!],
    });

    let nextRulesState: MarjapussiRulesState = {
      ...rulesState,
      currentTrick: {
        cards: [...rulesState.currentTrick.cards, playedCard],
        leadSuit: rulesState.currentTrick.leadSuit ?? (played.suit as Suit),
      },
      canDeclare: false, // Once a card is played, can no longer declare in this turn
    };

    let nextPlayer: string | null = null;
    const trickIsComplete =
      nextRulesState.currentTrick.cards.length === PLAYERS.length;

    if (!trickIsComplete) {
      nextPlayer = nextPlayerId(playerId);
      engineEvents.push({ type: "set-current-player", player: nextPlayer });
    } else {
      const winner = winningCard(
        nextRulesState.currentTrick.cards,
        nextRulesState.currentTrick.leadSuit,
        nextRulesState.trumpSuit
      );
      if (!winner) {
        return {
          valid: false,
          reason: "Could not determine trick winner.",
          engineEvents: [],
        };
      }
      const targetPile =
        partnershipFor(winner.player) === "NS" ? TEAM_NS_WON : TEAM_EW_WON;
      const trickCardIds = nextRulesState.currentTrick.cards.map(
        (c) => c.cardId
      );

      // Announce trick winner
      engineEvents.push({
        type: "announce",
        text: `Trick won by ${winner.player}`,
        anchor: { type: "pile", pileId: "trick" },
      });

      engineEvents.push({
        type: "move-cards",
        fromPileId: "trick",
        toPileId: targetPile,
        cardIds: trickCardIds as [number, ...number[]],
      });

      const isLastTrick = rulesState.trickNumber >= 9;
      if (isLastTrick) {
        const finish = finishHand(
          state,
          nextRulesState,
          engineEvents,
          winner.player
        );
        nextRulesState = finish.nextRulesState;

        if (nextRulesState.result) {
          engineEvents.push({
            type: "announce",
            text: nextRulesState.result,
            anchor: { type: "screen" },
          });
        }

        nextPlayer = finish.nextPlayer;
        if (finish.winner) {
          engineEvents.push({ type: "set-winner", winner: finish.winner });
        }
        engineEvents.push({ type: "set-current-player", player: nextPlayer });
      } else {
        nextRulesState = {
          ...nextRulesState,
          currentTrick: { cards: [], leadSuit: null },
          trickLeader: winner.player,
          trickNumber: rulesState.trickNumber + 1,
          canDeclare: true,
          lastTrickWinner: winner.player,
        };
        nextPlayer = winner.player;
        engineEvents.push({ type: "set-current-player", player: nextPlayer });
      }
    }

    engineEvents.push({ type: "set-rules-state", rulesState: nextRulesState });
    const actions = deriveActions(state, nextRulesState, nextPlayer);
    const scoreboards = deriveScoreboards(state, nextRulesState, engineEvents);
    engineEvents.push({ type: "set-actions", actions });
    engineEvents.push({ type: "set-scoreboards", scoreboards });

    return { valid: true, engineEvents };
  },
};

export const marjapussiPlugin: GamePlugin = {
  id: "marjapussi",
  gameName: META.gameName,
  description: META.description,
  ruleModule: marjapussiRuleModule,
  validationHints: {
    sharedPileIds: ["deck", "trick", TEAM_NS_WON, TEAM_EW_WON],
    isPileAlwaysVisibleToRules: (pileId: string) =>
      pileId.endsWith("-hand") || pileId === "deck",
  } satisfies ValidationHints,
};
