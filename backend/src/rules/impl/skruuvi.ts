import type { GamePlugin, GameRuleModule } from "../interface.js";
import type { ValidationState } from "../../validation-state.js";
import type {
  ActionCell,
  ActionGrid,
  ClientIntent,
  Scoreboard,
  ScoreboardCell,
} from "../../../../shared/schemas.js";
import type {
  EngineEvent,
  ValidationResult,
} from "../../../../shared/validation.js";
import { loadGameMeta } from "../meta.js";
import { getSuitSymbol } from "../../util/card-notation.js";
import {
  distributeRoundRobin,
  gatherAllCards,
  shuffleAllCards,
} from "../util/dealing.js";

const META = loadGameMeta("skruuvi");

const SEATS = ["N", "E", "S", "W"] as const;
const TOTAL_DEALS = 24;

type Seat = (typeof SEATS)[number];
type Partnership = "NS" | "EW";
type GameMode = "kitty" | "kotka" | "bolshevik";
type Denomination =
  | "misere"
  | "spades"
  | "clubs"
  | "diamonds"
  | "hearts"
  | "grand";

type SkruuviPhase =
  | "setup"
  | "auction"
  | "kitty-bidder-pass4"
  | "kitty-partner-distribute3"
  | "kotka-pass4-out"
  | "kotka-pass4-back"
  | "extended-bidding"
  | "defender-exchange-out"
  | "defender-exchange-back"
  | "doubling-def-left"
  | "doubling-def-right"
  | "redouble-first"
  | "redouble-second"
  | "all-pass-exchange"
  | "all-pass-doubling"
  | "all-pass-redouble-first"
  | "all-pass-redouble-second"
  | "bolshevik-auction"
  | "bolshevik-bidder-choice"
  | "bolshevik-bidder-distribute3"
  | "bolshevik-contract-choice"
  | "bolshevik-doubling"
  | "bolshevik-redouble"
  | "play";

interface Bid {
  level: number;
  denomination: Denomination;
  bidder: Seat;
}

interface Contract {
  level: number;
  denomination: Denomination;
  declarer: Seat | null;
  side: Partnership | null;
  multiplier: 1 | 2 | 3;
  doubledBy: Seat | null;
  redoubledBy: Seat | null;
  allPass: boolean;
}

interface TrickCard {
  cardId: number;
  player: Seat;
  rank: string;
  suit: string;
}

interface RoundStats {
  trickNumber: number;
  currentTrick: TrickCard[];
  tricksNS: number;
  tricksEW: number;
  acePenaltyNS: number;
  acePenaltyEW: number;
  allPassTrickPenaltyNS: number;
  allPassTrickPenaltyEW: number;
}

interface BolshevikSetState {
  active: boolean;
  dealsPlayed: number;
  declarersPlayed: Seat[];
  rawScores: Record<Seat, number>;
}

interface SkruuviRulesState {
  phase: SkruuviPhase;
  hasDealt: boolean;
  dealNumber: number;
  dealer: Seat;
  mode: GameMode | null;
  scores: Record<Seat, number>;
  lastDealDelta: Record<Seat, number>;
  result: string | null;
  recap: string[];
  auction: {
    history: Array<{ player: Seat; call: string }>;
    highestBid: Bid | null;
    consecutivePasses: number;
    totalCalls: number;
    firstBidLevel: number | null;
  };
  mainPlayers: {
    bidder: Seat;
    partner: Seat;
  } | null;
  contract: Contract | null;
  round: RoundStats;
  exchange: {
    bidderPassedCount: number;
    partnerGivenTo: Seat[];
    kotkaOutCount: number;
    kotkaBackCount: number;
    allPassExchangeIndex: number;
    bolshevikGivenTo: Seat[];
    bolshevikPasses: number;
    bolshevikDoubler: Seat | null;
    bolshevikAuctionIndex: number;
    bolshevikBidders: Seat[];
    bolshevikChoiceIndex: number;
    partnerSignalSuit: Record<Seat, string | null>;
    kittyBidderPacket: number[];
    kotkaOutPacket: number[];
    kotkaBackPacket: number[];
  };
  allPassDoublingPasses: number;
  bolshevik: BolshevikSetState;
  penalties: Record<Seat, number>;
}

interface InfractionPenalty {
  seat: Seat;
  points: number;
  text: string;
}

const RANK_VALUE: Record<string, number> = {
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

const DENOM_ORDER_KITTY: Denomination[] = [
  "misere",
  "spades",
  "clubs",
  "diamonds",
  "hearts",
  "grand",
];

const DENOM_ORDER_KOTKA: Denomination[] = [
  "spades",
  "clubs",
  "diamonds",
  "hearts",
  "misere",
  "grand",
];

function isSeat(playerId: string): playerId is Seat {
  return SEATS.includes(playerId as Seat);
}

function seatIndex(seat: Seat): number {
  return SEATS.indexOf(seat);
}

function nextSeat(seat: Seat): Seat {
  return SEATS[(seatIndex(seat) + 1) % SEATS.length];
}

function prevSeat(seat: Seat): Seat {
  return SEATS[(seatIndex(seat) + SEATS.length - 1) % SEATS.length];
}

function partnerOf(seat: Seat): Seat {
  if (seat === "N") return "S";
  if (seat === "S") return "N";
  if (seat === "E") return "W";
  return "E";
}

function sideOf(seat: Seat): Partnership {
  return seat === "N" || seat === "S" ? "NS" : "EW";
}

function normalSessionIndexForDeal(dealNumber: number): number {
  if (dealNumber <= 0) return 0;
  return Math.min(2, Math.floor((dealNumber - 1) / 8));
}

function partnerOfForDeal(dealNumber: number, seat: Seat): Seat {
  const session = normalSessionIndexForDeal(dealNumber);
  if (session === 0) return partnerOf(seat);
  if (session === 1) {
    if (seat === "N") return "E";
    if (seat === "E") return "N";
    if (seat === "S") return "W";
    return "S";
  }
  if (seat === "N") return "W";
  if (seat === "W") return "N";
  if (seat === "E") return "S";
  return "E";
}

function sideOfForDeal(dealNumber: number, seat: Seat): Partnership {
  const teamA = new Set<Seat>(["N", partnerOfForDeal(dealNumber, "N")]);
  return teamA.has(seat) ? "NS" : "EW";
}

function seatsForSide(dealNumber: number, side: Partnership): Seat[] {
  return SEATS.filter((seat) => sideOfForDeal(dealNumber, seat) === side);
}

function defendersClockwiseFrom(declarer: Seat, partner: Seat): [Seat, Seat] {
  const defenders = new Set<Seat>(
    SEATS.filter((seat) => seat !== declarer && seat !== partner)
  );
  const order: Seat[] = [];
  let cursor = nextSeat(declarer);
  while (order.length < 2) {
    if (defenders.has(cursor)) {
      order.push(cursor);
    }
    cursor = nextSeat(cursor);
  }
  return [order[0], order[1]];
}

function nextMainClockwiseFrom(
  start: Seat,
  bidder: Seat,
  partner: Seat
): Seat | null {
  let cursor = nextSeat(start);
  for (let i = 0; i < 4; i++) {
    if (cursor === bidder || cursor === partner) return cursor;
    cursor = nextSeat(cursor);
  }
  return null;
}

function bolshevikDefenderOrder(declarer: Seat): [Seat, Seat, Seat] {
  const right = prevSeat(declarer);
  const opposite = prevSeat(right);
  const left = nextSeat(declarer);
  return [right, opposite, left];
}

function bolshevikAuctionOrder(rs: SkruuviRulesState): Seat[] {
  const alreadyDeclared = new Set<Seat>(rs.bolshevik.declarersPlayed);
  const order: Seat[] = [];
  let cursor = rs.dealer;
  for (let i = 0; i < 4; i++) {
    if (!alreadyDeclared.has(cursor)) {
      order.push(cursor);
    }
    cursor = nextSeat(cursor);
  }
  return order;
}

function bolshevikSessionCanContinue(rs: SkruuviRulesState): boolean {
  return (
    rs.bolshevik.dealsPlayed < 8 && rs.bolshevik.declarersPlayed.length < 4
  );
}

function isForcedBolshevikDeal(rs: SkruuviRulesState): boolean {
  const remainingDeals = 8 - rs.bolshevik.dealsPlayed;
  const remainingPlayers = 4 - rs.bolshevik.declarersPlayed.length;
  return remainingDeals > 0 && remainingDeals === remainingPlayers;
}

function buildEmptyBolshevikSet(): BolshevikSetState {
  return {
    active: false,
    dealsPlayed: 0,
    declarersPlayed: [],
    rawScores: { N: 0, E: 0, S: 0, W: 0 },
  };
}

function buildEmptyPenaltyMap(): Record<Seat, number> {
  return { N: 0, E: 0, S: 0, W: 0 };
}

function contractMinLevel(mode: GameMode): number {
  return mode === "kitty" ? 5 : 6;
}

function modeForDeal(dealNumber: number): GameMode {
  const positionInSet = ((dealNumber - 1) % 8) + 1;
  return positionInSet <= 4 ? "kitty" : "kotka";
}

function buildEmptyRound(): RoundStats {
  return {
    trickNumber: 1,
    currentTrick: [],
    tricksNS: 0,
    tricksEW: 0,
    acePenaltyNS: 0,
    acePenaltyEW: 0,
    allPassTrickPenaltyNS: 0,
    allPassTrickPenaltyEW: 0,
  };
}

function buildBaseRulesState(): SkruuviRulesState {
  return {
    phase: "setup",
    hasDealt: false,
    dealNumber: 0,
    dealer: "N",
    mode: null,
    scores: { N: 0, E: 0, S: 0, W: 0 },
    lastDealDelta: { N: 0, E: 0, S: 0, W: 0 },
    result: null,
    recap: [],
    auction: {
      history: [],
      highestBid: null,
      consecutivePasses: 0,
      totalCalls: 0,
      firstBidLevel: null,
    },
    mainPlayers: null,
    contract: null,
    round: buildEmptyRound(),
    exchange: {
      bidderPassedCount: 0,
      partnerGivenTo: [],
      kotkaOutCount: 0,
      kotkaBackCount: 0,
      allPassExchangeIndex: 0,
      bolshevikGivenTo: [],
      bolshevikPasses: 0,
      bolshevikDoubler: null,
      bolshevikAuctionIndex: 0,
      bolshevikBidders: [],
      bolshevikChoiceIndex: 0,
      partnerSignalSuit: { N: null, E: null, S: null, W: null },
      kittyBidderPacket: [],
      kotkaOutPacket: [],
      kotkaBackPacket: [],
    },
    allPassDoublingPasses: 0,
    bolshevik: buildEmptyBolshevikSet(),
    penalties: buildEmptyPenaltyMap(),
  };
}

function getRulesState(raw: unknown): SkruuviRulesState {
  const base = buildBaseRulesState();
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Partial<SkruuviRulesState>;
  return {
    ...base,
    ...obj,
    scores: { ...base.scores, ...(obj.scores ?? {}) },
    lastDealDelta: { ...base.lastDealDelta, ...(obj.lastDealDelta ?? {}) },
    auction: { ...base.auction, ...(obj.auction ?? {}) },
    round: { ...base.round, ...(obj.round ?? {}) },
    exchange: {
      ...base.exchange,
      ...(obj.exchange ?? {}),
      partnerSignalSuit: {
        ...base.exchange.partnerSignalSuit,
        ...(obj.exchange?.partnerSignalSuit ?? {}),
      },
      kittyBidderPacket: Array.isArray(obj.exchange?.kittyBidderPacket)
        ? obj.exchange!.kittyBidderPacket
        : base.exchange.kittyBidderPacket,
      kotkaOutPacket: Array.isArray(obj.exchange?.kotkaOutPacket)
        ? obj.exchange!.kotkaOutPacket
        : base.exchange.kotkaOutPacket,
      kotkaBackPacket: Array.isArray(obj.exchange?.kotkaBackPacket)
        ? obj.exchange!.kotkaBackPacket
        : base.exchange.kotkaBackPacket,
      bolshevikBidders: Array.isArray(obj.exchange?.bolshevikBidders)
        ? obj.exchange!.bolshevikBidders
        : base.exchange.bolshevikBidders,
    },
    bolshevik: {
      ...base.bolshevik,
      ...(obj.bolshevik ?? {}),
      rawScores: {
        ...base.bolshevik.rawScores,
        ...(obj.bolshevik?.rawScores ?? {}),
      },
      declarersPlayed: Array.isArray(obj.bolshevik?.declarersPlayed)
        ? obj.bolshevik!.declarersPlayed
        : base.bolshevik.declarersPlayed,
    },
    penalties: { ...base.penalties, ...(obj.penalties ?? {}) },
    recap: Array.isArray(obj.recap) ? obj.recap : base.recap,
  };
}

function denominationOrder(mode: GameMode): Denomination[] {
  return mode === "kitty" ? DENOM_ORDER_KITTY : DENOM_ORDER_KOTKA;
}

function denominationLabel(denomination: Denomination): string {
  if (denomination === "grand") return "Grand";
  if (denomination === "misere") return "Misere";
  return getSuitSymbol(denomination);
}

function bidLabel(bid: Bid | null): string {
  if (!bid) return "—";
  return `${bid.level} ${denominationLabel(bid.denomination)} (${bid.bidder})`;
}

function compareBids(mode: GameMode, a: Bid, b: Bid): number {
  if (a.level !== b.level) return a.level - b.level;
  const order = denominationOrder(mode);
  return order.indexOf(a.denomination) - order.indexOf(b.denomination);
}

function parseBidAction(
  action: string
): { level: number; denomination: Denomination } | null {
  const match = /^bid:(\d):(misere|spades|clubs|diamonds|hearts|grand)$/.exec(
    action
  );
  if (!match) return null;
  return {
    level: Number(match[1]),
    denomination: match[2] as Denomination,
  };
}

function bidActionId(level: number, denomination: Denomination): string {
  return `bid:${level}:${denomination}`;
}

function asSeat(playerId: string): Seat | null {
  return isSeat(playerId) ? playerId : null;
}

function handCardCount(state: ValidationState, seat: Seat): number {
  const pile = state.piles[`${seat}-hand`];
  if (!pile) return 0;
  if (Array.isArray(pile.cards)) return pile.cards.length;
  if (typeof pile.size === "number") return pile.size;
  return 0;
}

function nextSeatWithCards(
  state: ValidationState,
  fromSeat: Seat,
  blockedSeats: Set<Seat>
): Seat | null {
  let probe = nextSeat(fromSeat);
  for (let i = 0; i < SEATS.length; i++) {
    if (!blockedSeats.has(probe) && handCardCount(state, probe) > 0) {
      return probe;
    }
    probe = nextSeat(probe);
  }
  return null;
}

function getCardFromPile(
  state: ValidationState,
  pileId: string,
  cardId: number
): { id: number; rank: string; suit: string } | null {
  const pile = state.piles[pileId];
  if (!pile?.cards) return null;
  return pile.cards.find((card) => card.id === cardId) ?? null;
}

function getCardById(
  state: ValidationState,
  cardId: number
): { id: number; rank: string; suit: string } | null {
  return state.allCards[cardId] ?? null;
}

function isPacketConventionCompliant(
  state: ValidationState,
  cardIds: number[]
): boolean {
  if (cardIds.length !== 4) return false;
  const resolved: Array<{ id: number; rank: string; suit: string }> = [];
  for (const id of cardIds) {
    const card = getCardById(state, id);
    if (!card) return false;
    resolved.push(card);
  }

  const runs: Array<Array<{ rank: string; suit: string }>> = [];
  for (const card of resolved) {
    const current = runs[runs.length - 1];
    if (!current || current[0].suit !== card.suit) {
      runs.push([{ rank: card.rank, suit: card.suit }]);
      continue;
    }
    current.push({ rank: card.rank, suit: card.suit });
  }

  const runLengths = runs.map((run) => run.length);
  const shapeOk =
    (runLengths.length === 1 && runLengths[0] === 4) ||
    (runLengths.length === 2 &&
      ((runLengths[0] === 3 && runLengths[1] === 1) ||
        (runLengths[0] === 1 && runLengths[1] === 3)));
  if (!shapeOk) return false;

  for (const run of runs) {
    for (let i = 1; i < run.length; i++) {
      if ((RANK_VALUE[run[i - 1].rank] ?? 0) < (RANK_VALUE[run[i].rank] ?? 0)) {
        return false;
      }
    }
  }

  return true;
}

function isHigherRank(rankA: string, rankB: string): boolean {
  return (RANK_VALUE[rankA] ?? 0) > (RANK_VALUE[rankB] ?? 0);
}

function trumpSuit(contract: Contract | null): string | null {
  if (!contract || contract.allPass) return null;
  if (
    contract.denomination === "spades" ||
    contract.denomination === "clubs" ||
    contract.denomination === "diamonds" ||
    contract.denomination === "hearts"
  ) {
    return contract.denomination;
  }
  return null;
}

function determineTrickWinner(
  trickCards: TrickCard[],
  contract: Contract | null
): Seat {
  const first = trickCards[0];
  let winning = first;
  const leadSuit = first.suit;
  const trump = trumpSuit(contract);

  for (let i = 1; i < trickCards.length; i++) {
    const card = trickCards[i];
    const winningIsTrump = trump !== null && winning.suit === trump;
    const cardIsTrump = trump !== null && card.suit === trump;

    if (cardIsTrump && !winningIsTrump) {
      winning = card;
      continue;
    }
    if (winningIsTrump && !cardIsTrump) {
      continue;
    }

    if (card.suit === winning.suit) {
      if (isHigherRank(card.rank, winning.rank)) {
        winning = card;
      }
      continue;
    }

    if (
      !winningIsTrump &&
      card.suit === leadSuit &&
      winning.suit !== leadSuit
    ) {
      winning = card;
    }
  }

  return winning.player;
}

function getAllPassExchangeSteps(
  dealer: Seat,
  dealNumber: number
): Array<{ actor: Seat; target: Seat }> {
  const left = nextSeat(dealer);
  const right = prevSeat(dealer);
  const dealerPartner = partnerOfForDeal(dealNumber, dealer);
  return [
    { actor: left, target: partnerOfForDeal(dealNumber, left) },
    { actor: dealerPartner, target: dealer },
    { actor: dealer, target: dealerPartner },
    { actor: right, target: partnerOfForDeal(dealNumber, right) },
  ];
}

function formatDealMode(mode: GameMode | null): string {
  if (mode === "kitty") return "Kitty";
  if (mode === "kotka") return "Kotka";
  if (mode === "bolshevik") return "Bolshevik";
  return "—";
}

function formatPhase(phase: SkruuviPhase): string {
  return phase.replace(/-/g, " ");
}

function addInfractionPenalty(
  rs: SkruuviRulesState,
  seat: Seat,
  points: number
): SkruuviRulesState {
  return {
    ...rs,
    penalties: {
      ...rs.penalties,
      [seat]: (rs.penalties[seat] ?? 0) + points,
    },
  };
}

function withInfractionPenalty(
  rs: SkruuviRulesState,
  penalty: InfractionPenalty | null,
  events: EngineEvent[]
): SkruuviRulesState {
  if (!penalty) return rs;
  events.push({
    type: "announce",
    text: `${penalty.text} Penalty: ${penalty.seat} -${penalty.points}.`,
    anchor: { type: "screen" },
  });
  return addInfractionPenalty(rs, penalty.seat, penalty.points);
}

function sideLabelForSeat(rs: SkruuviRulesState, seat: Seat): string {
  if (rs.mode === "bolshevik" && rs.contract?.declarer) {
    return rs.contract.declarer === seat ? "Solo" : "Def";
  }
  if (rs.dealNumber <= 0) {
    return sideOf(seat);
  }
  const partner = partnerOfForDeal(rs.dealNumber, seat);
  return [seat, partner].sort().join("");
}

function buildScoreboards(
  state: ValidationState,
  rs: SkruuviRulesState
): Scoreboard[] {
  const playerName = (seat: Seat) =>
    state.players.find((p) => p.id === seat)?.name ?? seat;

  const scoreCells: ScoreboardCell[] = [
    { row: 0, col: 0, text: "Player", role: "header", align: "left" },
    { row: 0, col: 1, text: "Side", role: "header", align: "center" },
    { row: 0, col: 2, text: "Total", role: "header", align: "right" },
    { row: 0, col: 3, text: "Last Deal", role: "header", align: "right" },
  ];

  SEATS.forEach((seat, idx) => {
    scoreCells.push(
      { row: idx + 1, col: 0, text: playerName(seat), align: "left" },
      {
        row: idx + 1,
        col: 1,
        text: sideLabelForSeat(rs, seat),
        align: "center",
      },
      {
        row: idx + 1,
        col: 2,
        text: String(rs.scores[seat] ?? 0),
        align: "right",
      },
      {
        row: idx + 1,
        col: 3,
        text: String(rs.lastDealDelta[seat] ?? 0),
        align: "right",
      }
    );
  });

  const detailsCells: ScoreboardCell[] = [
    { row: 0, col: 0, text: "Field", role: "header", align: "left" },
    { row: 0, col: 1, text: "Value", role: "header", align: "left" },
    { row: 1, col: 0, text: "Deal", role: "header", align: "left" },
    { row: 1, col: 1, text: `${rs.dealNumber}/${TOTAL_DEALS}` },
    { row: 2, col: 0, text: "Mode", role: "header", align: "left" },
    { row: 2, col: 1, text: formatDealMode(rs.mode) },
    { row: 3, col: 0, text: "Phase", role: "header", align: "left" },
    { row: 3, col: 1, text: formatPhase(rs.phase) },
    { row: 4, col: 0, text: "Bid / Contract", role: "header", align: "left" },
    {
      row: 4,
      col: 1,
      text: rs.contract?.allPass
        ? "All-pass Misere"
        : bidLabel(rs.auction.highestBid),
    },
    { row: 5, col: 0, text: "Tricks", role: "header", align: "left" },
    {
      row: 5,
      col: 1,
      text: `NS ${rs.round.tricksNS} / EW ${rs.round.tricksEW}`,
    },
    { row: 6, col: 0, text: "Multiplier", role: "header", align: "left" },
    {
      row: 6,
      col: 1,
      text: rs.contract ? `x${rs.contract.multiplier}` : "x1",
    },
    { row: 7, col: 0, text: "Dealer", role: "header", align: "left" },
    { row: 7, col: 1, text: rs.dealer },
  ];

  return [
    {
      id: "skruuvi-score",
      title: "Skruuvi Scores",
      rows: 5,
      cols: 4,
      cells: scoreCells,
    },
    {
      id: "skruuvi-round",
      title: "Current Deal",
      rows: 8,
      cols: 2,
      cells: detailsCells,
    },
  ];
}

function buildStartActions(
  rs: SkruuviRulesState,
  currentPlayer: string | null
): ActionGrid {
  if (!currentPlayer) return { rows: 0, cols: 0, cells: [] };
  if (rs.bolshevik.active) {
    const canStart = bolshevikSessionCanContinue(rs);
    return {
      rows: 1,
      cols: 1,
      cells: [
        {
          id: "start-bolshevik-deal",
          label: "Start Bolshevik Deal",
          enabled: canStart,
          row: 0,
          col: 0,
        },
      ],
    };
  }
  return {
    rows: 1,
    cols: 2,
    cells: [
      {
        id: "start-game",
        label: "Start Deal",
        enabled: true,
        row: 0,
        col: 0,
      },
      {
        id: "start-bolshevik-set",
        label: "Start Bolshevik Set",
        enabled: true,
        row: 0,
        col: 1,
      },
    ],
  };
}

function buildBidActions(
  rs: SkruuviRulesState,
  currentPlayer: Seat,
  mode: GameMode,
  isExtended: boolean
): ActionGrid {
  const order = denominationOrder(mode);
  const minOpenLevel =
    !isExtended && rs.auction.highestBid === null && mode === "kotka" ? 6 : 1;
  const minFinal = contractMinLevel(mode);
  const passEnabled =
    !isExtended || (rs.auction.highestBid?.level ?? 0) >= minFinal;

  const cells: ActionCell[] = [];
  let row = 0;
  for (let level = 1; level <= 7; level++) {
    let col = 0;
    for (const denomination of order) {
      const candidate: Bid = { level, denomination, bidder: currentPlayer };
      const higherThanCurrent = rs.auction.highestBid
        ? compareBids(mode, candidate, rs.auction.highestBid) > 0
        : level >= minOpenLevel;
      cells.push({
        id: bidActionId(level, denomination),
        label: `${level} ${denominationLabel(denomination)}`,
        enabled: higherThanCurrent,
        row,
        col,
      });
      col++;
    }
    row++;
  }

  cells.push({
    id: "pass",
    label: "Pass",
    enabled: passEnabled,
    row,
    col: 0,
    colspan: Math.max(1, order.length),
  });

  return { rows: row + 1, cols: Math.max(1, order.length), cells };
}

function buildDoubleActions(
  canDouble: boolean,
  canRedouble: boolean
): ActionGrid {
  const cells: ActionCell[] = [
    { id: "pass", label: "Pass", enabled: true, row: 0, col: 0 },
  ];
  if (canDouble) {
    cells.push({
      id: "double",
      label: "Double",
      enabled: true,
      row: 0,
      col: 1,
    });
  }
  if (canRedouble) {
    cells.push({
      id: "redouble",
      label: "Redouble",
      enabled: true,
      row: 0,
      col: canDouble ? 2 : 1,
    });
  }
  return { rows: 1, cols: Math.max(2, cells.length), cells };
}

function buildBolshevikAuctionActions(
  rs: SkruuviRulesState,
  currentPlayer: Seat
): ActionGrid {
  const alreadyPlayed = rs.bolshevik.declarersPlayed.includes(currentPlayer);
  return {
    rows: 1,
    cols: 2,
    cells: [
      { id: "pass", label: "Pass", enabled: true, row: 0, col: 0 },
      {
        id: "bolshevik",
        label: "Bolshevik",
        enabled: !alreadyPlayed,
        row: 0,
        col: 1,
      },
    ],
  };
}

function buildBolshevikChoiceActions(): ActionGrid {
  return {
    rows: 1,
    cols: 2,
    cells: [
      { id: "pass", label: "Pass", enabled: true, row: 0, col: 0 },
      { id: "bolshevik", label: "Bolshevik", enabled: true, row: 0, col: 1 },
    ],
  };
}

function buildBolshevikContractActions(): ActionGrid {
  const cells: ActionCell[] = [
    { id: "pass", label: "7 Misere", enabled: true, row: 0, col: 0 },
    { id: "bid:7:spades", label: "7 ♠️", enabled: true, row: 0, col: 1 },
    { id: "bid:7:clubs", label: "7 ♣️", enabled: true, row: 0, col: 2 },
    { id: "bid:7:diamonds", label: "7 ♦️", enabled: true, row: 0, col: 3 },
    { id: "bid:7:hearts", label: "7 ♥️", enabled: true, row: 0, col: 4 },
    { id: "bid:7:grand", label: "7 Grand", enabled: true, row: 0, col: 5 },
  ];
  return { rows: 1, cols: 6, cells };
}

function withUiEvents(
  state: ValidationState,
  rs: SkruuviRulesState,
  events: EngineEvent[],
  currentPlayer: string | null
) {
  events.push({ type: "set-rules-state", rulesState: rs });
  events.push({ type: "set-current-player", player: currentPlayer });

  let actions: ActionGrid = { rows: 0, cols: 0, cells: [] };
  if (rs.phase === "setup" && !state.winner) {
    actions = buildStartActions(rs, currentPlayer);
  } else if (
    (rs.phase === "auction" || rs.phase === "extended-bidding") &&
    rs.mode &&
    currentPlayer &&
    isSeat(currentPlayer)
  ) {
    actions = buildBidActions(
      rs,
      currentPlayer,
      rs.mode,
      rs.phase === "extended-bidding"
    );
  } else if (
    rs.phase === "bolshevik-auction" &&
    currentPlayer &&
    isSeat(currentPlayer)
  ) {
    actions = buildBolshevikAuctionActions(rs, currentPlayer);
  } else if (rs.phase === "bolshevik-bidder-choice") {
    actions = buildBolshevikChoiceActions();
  } else if (rs.phase === "bolshevik-contract-choice") {
    actions = buildBolshevikContractActions();
  } else if (rs.phase === "bolshevik-doubling") {
    actions = buildDoubleActions(true, false);
  } else if (rs.phase === "bolshevik-redouble") {
    actions = buildDoubleActions(false, true);
  } else if (
    rs.phase === "doubling-def-left" ||
    rs.phase === "doubling-def-right" ||
    rs.phase === "all-pass-doubling"
  ) {
    actions = buildDoubleActions(true, false);
  } else if (
    rs.phase === "redouble-first" ||
    rs.phase === "redouble-second" ||
    rs.phase === "all-pass-redouble-first" ||
    rs.phase === "all-pass-redouble-second"
  ) {
    actions = buildDoubleActions(false, true);
  }

  events.push({ type: "set-actions", actions });
  events.push({
    type: "set-scoreboards",
    scoreboards: buildScoreboards(state, rs),
  });
}

function ensureSkruuviSeats(state: ValidationState): string | null {
  if (state.players.length !== 4) {
    return "Skruuvi requires exactly 4 players.";
  }
  const ids = state.players
    .map((p) => p.id)
    .sort()
    .join(",");
  if (ids !== "E,N,S,W") {
    return "Skruuvi requires seat ids N, E, S, W.";
  }
  return null;
}

function buildDealStart(
  state: ValidationState,
  rs: SkruuviRulesState,
  requestedMode?: GameMode
): ValidationResult {
  const seatError = ensureSkruuviSeats(state);
  if (seatError) {
    return { valid: false, reason: seatError, engineEvents: [] };
  }

  const isBolshevik = requestedMode === "bolshevik" || rs.bolshevik.active;
  const nextDealNumber = isBolshevik ? rs.dealNumber : rs.dealNumber + 1;
  const nextBolshevikDeal = isBolshevik ? rs.bolshevik.dealsPlayed + 1 : 0;
  const mode = isBolshevik ? "bolshevik" : modeForDeal(nextDealNumber);
  const cardsPerPlayer = mode === "kitty" ? 12 : 13;
  const resolvedCardsPerPlayer = mode === "bolshevik" ? 12 : cardsPerPlayer;
  const dealer = rs.dealer;
  const startSeat = nextSeat(dealer);

  const events: EngineEvent[] = [];
  events.push(...gatherAllCards(state));

  const shuffleDealNumber = isBolshevik
    ? 100 + nextBolshevikDeal
    : nextDealNumber;
  const shuffled = shuffleAllCards(state, shuffleDealNumber, "SKRUUVI", {
    useCurrentDeckIfFull: false,
  });

  const targets: Seat[] = [];
  let s: Seat = startSeat;
  for (let i = 0; i < 4; i++) {
    targets.push(s);
    s = nextSeat(s);
  }

  const dealTargets = targets.map((seat) => `${seat}-hand`);
  const { events: dealEvents } = distributeRoundRobin(
    shuffled,
    dealTargets,
    resolvedCardsPerPlayer
  );
  events.push(...dealEvents);

  const nextRulesState: SkruuviRulesState = {
    ...rs,
    hasDealt: true,
    phase: isBolshevik ? "bolshevik-auction" : "auction",
    dealNumber: nextDealNumber,
    mode,
    result: null,
    auction: {
      history: [],
      highestBid: null,
      consecutivePasses: 0,
      totalCalls: 0,
      firstBidLevel: null,
    },
    mainPlayers: null,
    contract: null,
    round: buildEmptyRound(),
    exchange: {
      bidderPassedCount: 0,
      partnerGivenTo: [],
      kotkaOutCount: 0,
      kotkaBackCount: 0,
      allPassExchangeIndex: 0,
      bolshevikGivenTo: [],
      bolshevikPasses: 0,
      bolshevikDoubler: null,
      bolshevikAuctionIndex: 0,
      bolshevikBidders: [],
      bolshevikChoiceIndex: 0,
      partnerSignalSuit: { N: null, E: null, S: null, W: null },
      kittyBidderPacket: [],
      kotkaOutPacket: [],
      kotkaBackPacket: [],
    },
    allPassDoublingPasses: 0,
    penalties: buildEmptyPenaltyMap(),
    lastDealDelta: { N: 0, E: 0, S: 0, W: 0 },
    bolshevik: isBolshevik
      ? {
          ...rs.bolshevik,
          active: true,
          dealsPlayed: nextBolshevikDeal,
        }
      : rs.bolshevik,
    recap: [
      isBolshevik
        ? `Bolshevik deal ${nextBolshevikDeal} started, dealer ${dealer}.`
        : `Deal ${nextDealNumber} started (${mode === "kitty" ? "Kitty" : "Kotka"}), dealer ${dealer}.`,
    ],
  };

  events.push({
    type: "announce",
    text: isBolshevik
      ? `Bolshevik deal ${nextBolshevikDeal}: dealer ${dealer}.`
      : `Deal ${nextDealNumber}: ${mode === "kitty" ? "Kitty" : "Kotka"} game. Dealer ${dealer}.`,
    anchor: { type: "screen" },
  });

  const bolshevikActor = isBolshevik
    ? (bolshevikAuctionOrder(nextRulesState)[0] ?? null)
    : null;
  withUiEvents(
    state,
    nextRulesState,
    events,
    isBolshevik ? bolshevikActor : dealer
  );
  return { valid: true, engineEvents: events };
}

function enterPlayPhase(
  state: ValidationState,
  rs: SkruuviRulesState,
  events: EngineEvent[],
  openingLeader: Seat
) {
  const nextRulesState: SkruuviRulesState = {
    ...rs,
    phase: "play",
    round: {
      ...rs.round,
      trickNumber: 1,
      currentTrick: [],
      tricksNS: 0,
      tricksEW: 0,
      acePenaltyNS: 0,
      acePenaltyEW: 0,
      allPassTrickPenaltyNS: 0,
      allPassTrickPenaltyEW: 0,
    },
  };

  events.push({
    type: "announce",
    text: `Play starts. ${openingLeader} leads.`,
    anchor: { type: "screen" },
  });

  withUiEvents(state, nextRulesState, events, openingLeader);
}

function computeContractComponent(
  contract: Contract,
  mainTricks: number
): number {
  if (contract.allPass) return 0;

  const level = contract.level;
  const multiplier = contract.multiplier;
  const madeTrumpGrand = level === 5 ? 25 : level === 6 ? 35 : 50;
  const madeMisere = level === 5 ? 10 : level === 6 ? 20 : 35;
  const overtrickValue = level < 7 ? 2 : 0;
  const firstUnderTrumpGrand = level === 5 ? 5 : level === 6 ? 10 : 15;
  const firstUnderMisere = level === 5 ? 10 : level === 6 ? 15 : 20;

  if (contract.denomination === "misere") {
    const maxAllowed = 7 - level;
    if (mainTricks <= maxAllowed) {
      const overtricks = maxAllowed - mainTricks;
      return (madeMisere + overtricks * overtrickValue) * multiplier;
    }
    const under = mainTricks - maxAllowed;
    const penalty = firstUnderMisere + Math.max(0, under - 1) * 5;
    return -penalty * multiplier;
  }

  const target = 6 + level;
  if (mainTricks >= target) {
    const overtricks = mainTricks - target;
    return (madeTrumpGrand + overtricks * overtrickValue) * multiplier;
  }
  const under = target - mainTricks;
  const penalty = firstUnderTrumpGrand + Math.max(0, under - 1) * 5;
  return -penalty * multiplier;
}

function computeSeatDeltas(rs: SkruuviRulesState): {
  deltas: Record<Seat, number>;
  summary: string;
  bolshevikRaw: boolean;
} {
  const contract = rs.contract;
  if (!contract) {
    return {
      deltas: { N: 0, E: 0, S: 0, W: 0 },
      summary: "No contract.",
      bolshevikRaw: false,
    };
  }

  const zero: Record<Seat, number> = { N: 0, E: 0, S: 0, W: 0 };

  if (contract.allPass) {
    const nsPenalty =
      rs.round.allPassTrickPenaltyNS * contract.multiplier +
      rs.round.acePenaltyNS;
    const ewPenalty =
      rs.round.allPassTrickPenaltyEW * contract.multiplier +
      rs.round.acePenaltyEW;
    const ns = ewPenalty - nsPenalty;
    const ew = -ns;
    const result: Record<Seat, number> = { ...zero };
    for (const seat of seatsForSide(rs.dealNumber, "NS")) {
      result[seat] = ns;
    }
    for (const seat of seatsForSide(rs.dealNumber, "EW")) {
      result[seat] = ew;
    }
    return {
      deltas: result,
      summary: `All-pass Misere: NS penalty ${nsPenalty}, EW penalty ${ewPenalty}.`,
      bolshevikRaw: false,
    };
  }

  if (rs.mode === "bolshevik" && contract.declarer) {
    const declarer = contract.declarer;
    const defenders = SEATS.filter((seat) => seat !== declarer);
    const declarerTricks = rs.round.tricksNS;
    const component = computeContractComponent(contract, declarerTricks);
    const declarerDelta =
      component + (rs.round.acePenaltyEW - rs.round.acePenaltyNS);
    const eachDefender = -declarerDelta / 3;
    const result: Record<Seat, number> = { ...zero };
    result[declarer] = declarerDelta;
    for (const defender of defenders) {
      result[defender] = eachDefender;
    }
    const contractText = `${contract.level} ${denominationLabel(contract.denomination)} x${contract.multiplier}`;
    return {
      deltas: result,
      summary: `${contractText} Bolshevik by ${declarer}: won ${declarerTricks} tricks.`,
      bolshevikRaw: true,
    };
  }

  const declarerSide = contract.side!;
  const defendersSide: Partnership = declarerSide === "NS" ? "EW" : "NS";
  const mainTricks =
    declarerSide === "NS" ? rs.round.tricksNS : rs.round.tricksEW;
  const component = computeContractComponent(contract, mainTricks);

  const sideAcePenalty =
    declarerSide === "NS" ? rs.round.acePenaltyNS : rs.round.acePenaltyEW;
  const oppAcePenalty =
    defendersSide === "NS" ? rs.round.acePenaltyNS : rs.round.acePenaltyEW;
  const declarerDelta = component + (oppAcePenalty - sideAcePenalty);
  const defendersDelta = -declarerDelta;

  const result: Record<Seat, number> = { ...zero };
  for (const seat of seatsForSide(rs.dealNumber, declarerSide)) {
    result[seat] = declarerDelta;
  }
  for (const seat of seatsForSide(rs.dealNumber, defendersSide)) {
    result[seat] = defendersDelta;
  }

  const contractText = `${contract.level} ${denominationLabel(contract.denomination)} x${contract.multiplier}`;
  return {
    deltas: result,
    summary: `${contractText} by ${contract.declarer}: main side won ${mainTricks} tricks.`,
    bolshevikRaw: false,
  };
}

function determineWinner(scores: Record<Seat, number>): Seat | null {
  const ranked = [...SEATS].sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
  if ((scores[ranked[0]] ?? 0) === (scores[ranked[1]] ?? 0)) {
    return null;
  }
  return ranked[0];
}

function finishRound(
  state: ValidationState,
  rs: SkruuviRulesState,
  events: EngineEvent[]
) {
  const { deltas, summary, bolshevikRaw } = computeSeatDeltas(rs);
  const sideNs = seatsForSide(rs.dealNumber, "NS");
  const sideEw = seatsForSide(rs.dealNumber, "EW");
  const nsValue = sideNs.length > 0 ? (deltas[sideNs[0]] ?? 0) : 0;
  const ewValue = sideEw.length > 0 ? (deltas[sideEw[0]] ?? 0) : 0;

  let nextScores: Record<Seat, number> = { ...rs.scores };
  let lastDealDelta: Record<Seat, number> = { ...deltas };
  let nextBolshevik: BolshevikSetState = { ...rs.bolshevik };
  let resultText = `Deal ${rs.dealNumber} scored: NS ${nsValue >= 0 ? "+" : ""}${nsValue}, EW ${ewValue >= 0 ? "+" : ""}${ewValue}.`;

  if (bolshevikRaw) {
    nextBolshevik = {
      ...nextBolshevik,
      rawScores: {
        N: (nextBolshevik.rawScores.N ?? 0) + (deltas.N ?? 0),
        E: (nextBolshevik.rawScores.E ?? 0) + (deltas.E ?? 0),
        S: (nextBolshevik.rawScores.S ?? 0) + (deltas.S ?? 0),
        W: (nextBolshevik.rawScores.W ?? 0) + (deltas.W ?? 0),
      },
    };

    if (
      rs.contract?.declarer &&
      !nextBolshevik.declarersPlayed.includes(rs.contract.declarer)
    ) {
      nextBolshevik.declarersPlayed = [
        ...nextBolshevik.declarersPlayed,
        rs.contract.declarer,
      ];
    }

    const setComplete =
      nextBolshevik.declarersPlayed.length >= 4 ||
      nextBolshevik.dealsPlayed >= 8;

    if (setComplete) {
      const normalized: Record<Seat, number> = {
        N: nextBolshevik.rawScores.N / 3,
        E: nextBolshevik.rawScores.E / 3,
        S: nextBolshevik.rawScores.S / 3,
        W: nextBolshevik.rawScores.W / 3,
      };
      nextScores = {
        N: (rs.scores.N ?? 0) + normalized.N,
        E: (rs.scores.E ?? 0) + normalized.E,
        S: (rs.scores.S ?? 0) + normalized.S,
        W: (rs.scores.W ?? 0) + normalized.W,
      };
      lastDealDelta = normalized;
      resultText = `Bolshevik session scored: N ${normalized.N >= 0 ? "+" : ""}${normalized.N}, E ${normalized.E >= 0 ? "+" : ""}${normalized.E}, S ${normalized.S >= 0 ? "+" : ""}${normalized.S}, W ${normalized.W >= 0 ? "+" : ""}${normalized.W}.`;
      nextBolshevik = buildEmptyBolshevikSet();
    } else {
      lastDealDelta = { N: 0, E: 0, S: 0, W: 0 };
      resultText = `Bolshevik deal ${nextBolshevik.dealsPlayed} recorded (raw session scores pending).`;
    }
  } else {
    nextScores = {
      N: (rs.scores.N ?? 0) + (deltas.N ?? 0),
      E: (rs.scores.E ?? 0) + (deltas.E ?? 0),
      S: (rs.scores.S ?? 0) + (deltas.S ?? 0),
      W: (rs.scores.W ?? 0) + (deltas.W ?? 0),
    };
  }

  const penaltySummary = SEATS.filter((seat) => (rs.penalties[seat] ?? 0) > 0)
    .map((seat) => `${seat} -${rs.penalties[seat]}`)
    .join(", ");
  if (penaltySummary.length > 0) {
    for (const seat of SEATS) {
      const penalty = rs.penalties[seat] ?? 0;
      if (penalty > 0) {
        nextScores[seat] = (nextScores[seat] ?? 0) - penalty;
        lastDealDelta[seat] = (lastDealDelta[seat] ?? 0) - penalty;
      }
    }
  }

  events.push({
    type: "announce",
    text:
      penaltySummary.length > 0
        ? `${summary} ${resultText} Penalties: ${penaltySummary}.`
        : `${summary} ${resultText}`,
    anchor: { type: "screen" },
  });

  const finishedGame = !nextBolshevik.active && rs.dealNumber >= TOTAL_DEALS;
  if (finishedGame) {
    const winner = determineWinner(nextScores);
    const endState: SkruuviRulesState = {
      ...rs,
      hasDealt: false,
      phase: "setup",
      scores: nextScores,
      lastDealDelta,
      result: resultText,
      bolshevik: nextBolshevik,
      penalties: buildEmptyPenaltyMap(),
      recap: [...rs.recap.slice(-4), `${summary} ${resultText}`],
    };
    withUiEvents(state, endState, events, null);
    if (winner) {
      events.push({
        type: "announce",
        text: `Match complete. Winner: ${winner}.`,
        anchor: { type: "screen" },
      });
      events.push({ type: "set-winner", winner });
    } else {
      events.push({
        type: "announce",
        text: "Match complete. Tie.",
        anchor: { type: "screen" },
      });
      events.push({ type: "set-winner", winner: null });
    }
    return;
  }

  const nextDealer = nextSeat(rs.dealer);
  const nextState: SkruuviRulesState = {
    ...rs,
    hasDealt: false,
    phase: "setup",
    dealer: nextDealer,
    scores: nextScores,
    lastDealDelta,
    result: resultText,
    mode: null,
    auction: {
      history: [],
      highestBid: null,
      consecutivePasses: 0,
      totalCalls: 0,
      firstBidLevel: null,
    },
    mainPlayers: null,
    contract: null,
    round: buildEmptyRound(),
    exchange: {
      bidderPassedCount: 0,
      partnerGivenTo: [],
      kotkaOutCount: 0,
      kotkaBackCount: 0,
      allPassExchangeIndex: 0,
      bolshevikGivenTo: [],
      bolshevikPasses: 0,
      bolshevikDoubler: null,
      bolshevikAuctionIndex: 0,
      bolshevikBidders: [],
      bolshevikChoiceIndex: 0,
      partnerSignalSuit: { N: null, E: null, S: null, W: null },
      kittyBidderPacket: [],
      kotkaOutPacket: [],
      kotkaBackPacket: [],
    },
    allPassDoublingPasses: 0,
    bolshevik: nextBolshevik,
    penalties: buildEmptyPenaltyMap(),
    recap: [...rs.recap.slice(-4), `${summary} ${resultText}`],
  };

  withUiEvents(state, nextState, events, nextDealer);
}

function applyRoundTrickProgress(
  rs: SkruuviRulesState,
  trickCards: TrickCard[],
  winner: Seat
): SkruuviRulesState {
  const round = { ...rs.round };
  const winnerSide =
    rs.mode === "bolshevik" && rs.contract?.declarer
      ? rs.contract.declarer === winner
        ? "NS"
        : "EW"
      : sideOfForDeal(rs.dealNumber, winner);
  const aceCount = trickCards.filter((card) => card.rank === "A").length;

  if (winnerSide === "NS") {
    round.tricksNS += 1;
    if (rs.contract?.allPass) {
      round.allPassTrickPenaltyNS += 1;
    }
    if (rs.contract?.allPass || rs.contract?.denomination === "misere") {
      round.acePenaltyNS += aceCount * round.trickNumber;
    }
  } else {
    round.tricksEW += 1;
    if (rs.contract?.allPass) {
      round.allPassTrickPenaltyEW += 1;
    }
    if (rs.contract?.allPass || rs.contract?.denomination === "misere") {
      round.acePenaltyEW += aceCount * round.trickNumber;
    }
  }

  round.currentTrick = [];
  round.trickNumber += 1;

  return { ...rs, round };
}

function legalMoveTargetsForCurrentPhase(
  rs: SkruuviRulesState,
  player: Seat
): string[] {
  if (rs.phase === "play") {
    return ["table"];
  }
  if (!rs.mainPlayers && rs.phase !== "all-pass-exchange") {
    return [];
  }
  if (rs.phase === "kitty-bidder-pass4") {
    return [`${rs.mainPlayers!.partner}-hand`];
  }
  if (rs.phase === "kitty-partner-distribute3") {
    const disallowed = new Set<Seat>([
      rs.mainPlayers!.partner,
      ...rs.exchange.partnerGivenTo,
    ]);
    return SEATS.filter((seat) => !disallowed.has(seat)).map(
      (seat) => `${seat}-hand`
    );
  }
  if (rs.phase === "kotka-pass4-out") {
    return [`${rs.mainPlayers!.partner}-hand`];
  }
  if (rs.phase === "kotka-pass4-back") {
    return [`${rs.mainPlayers!.bidder}-hand`];
  }
  if (rs.phase === "defender-exchange-out") {
    return [`${partnerOfForDeal(rs.dealNumber, player)}-hand`];
  }
  if (rs.phase === "defender-exchange-back") {
    return [`${partnerOfForDeal(rs.dealNumber, player)}-hand`];
  }
  if (rs.phase === "bolshevik-bidder-distribute3") {
    if (!rs.contract?.declarer) return [];
    if (player !== rs.contract.declarer) return [];
    const used = new Set<Seat>(rs.exchange.bolshevikGivenTo);
    const defenders = SEATS.filter((seat) => seat !== rs.contract!.declarer);
    return defenders
      .filter((seat) => !used.has(seat))
      .map((seat) => `${seat}-hand`);
  }
  if (rs.phase === "all-pass-exchange") {
    const step = getAllPassExchangeSteps(rs.dealer, rs.dealNumber)[
      rs.exchange.allPassExchangeIndex
    ];
    if (!step) return [];
    return [`${step.target}-hand`];
  }
  return [];
}

function validateActionAvailable(
  state: ValidationState,
  rs: SkruuviRulesState,
  action: string
): string | null {
  const currentPlayer = asSeat(state.currentPlayer ?? "");
  if (!currentPlayer) return "No active player.";
  let actions: ActionGrid = { rows: 0, cols: 0, cells: [] };

  if (rs.phase === "auction" || rs.phase === "extended-bidding") {
    if (!rs.mode) return "Mode is missing.";
    actions = buildBidActions(
      rs,
      currentPlayer,
      rs.mode,
      rs.phase === "extended-bidding"
    );
  } else if (
    rs.phase === "doubling-def-left" ||
    rs.phase === "doubling-def-right" ||
    rs.phase === "all-pass-doubling"
  ) {
    actions = buildDoubleActions(true, false);
  } else if (
    rs.phase === "redouble-first" ||
    rs.phase === "redouble-second" ||
    rs.phase === "all-pass-redouble-first" ||
    rs.phase === "all-pass-redouble-second"
  ) {
    actions = buildDoubleActions(false, true);
  } else if (rs.phase === "setup") {
    actions = buildStartActions(rs, currentPlayer);
  } else if (rs.phase === "bolshevik-auction") {
    actions = buildBolshevikAuctionActions(rs, currentPlayer);
  } else if (rs.phase === "bolshevik-bidder-choice") {
    actions = buildBolshevikChoiceActions();
  } else if (rs.phase === "bolshevik-contract-choice") {
    actions = buildBolshevikContractActions();
  } else if (rs.phase === "bolshevik-doubling") {
    actions = buildDoubleActions(true, false);
  } else if (rs.phase === "bolshevik-redouble") {
    actions = buildDoubleActions(false, true);
  } else {
    return "No actions available in this phase.";
  }

  const cell = actions.cells.find((entry) => entry.id === action);
  if (!cell) return "That action is not available right now.";
  if (!cell.enabled) return "That action is currently disabled.";
  return null;
}

function enterBolshevikBid(
  state: ValidationState,
  rs: SkruuviRulesState,
  events: EngineEvent[],
  declarer: Seat,
  announceText: string
): ValidationResult {
  const kittyCards = state.piles.deck.cards?.map((card) => card.id) ?? [];
  if (kittyCards.length !== 4) {
    return {
      valid: false,
      reason: "Bolshevik deal requires a kitty of 4 cards.",
      engineEvents: [],
    };
  }

  events.push({
    type: "move-cards",
    fromPileId: "deck",
    toPileId: "table",
    cardIds: kittyCards as [number, ...number[]],
  });
  events.push({
    type: "announce",
    text: "Bolshevik kitty is revealed.",
    anchor: { type: "pile", pileId: "table" },
  });
  events.push({
    type: "move-cards",
    fromPileId: "table",
    toPileId: `${declarer}-hand`,
    cardIds: kittyCards as [number, ...number[]],
  });
  events.push({
    type: "announce",
    text: announceText,
    anchor: { type: "screen" },
  });

  const nextState: SkruuviRulesState = {
    ...rs,
    mainPlayers: { bidder: declarer, partner: declarer },
    contract: {
      level: 7,
      denomination: "misere",
      declarer,
      side: "NS",
      multiplier: 1,
      doubledBy: null,
      redoubledBy: null,
      allPass: false,
    },
    phase: "bolshevik-bidder-distribute3",
    exchange: {
      ...rs.exchange,
      bolshevikGivenTo: [],
      bolshevikPasses: 0,
      bolshevikDoubler: null,
      bolshevikAuctionIndex: 0,
      bolshevikBidders: [],
      bolshevikChoiceIndex: 0,
    },
  };
  withUiEvents(state, nextState, events, declarer);
  return { valid: true, engineEvents: events };
}

function annulBolshevikDeal(
  state: ValidationState,
  rs: SkruuviRulesState,
  events: EngineEvent[]
): ValidationResult {
  const nextDealer = nextSeat(rs.dealer);
  const nextState: SkruuviRulesState = {
    ...rs,
    hasDealt: false,
    phase: "setup",
    dealer: nextDealer,
    mode: null,
    result: "Bolshevik deal annulled (all passed).",
    auction: {
      history: [],
      highestBid: null,
      consecutivePasses: 0,
      totalCalls: 0,
      firstBidLevel: null,
    },
    mainPlayers: null,
    contract: null,
    round: buildEmptyRound(),
    exchange: {
      bidderPassedCount: 0,
      partnerGivenTo: [],
      kotkaOutCount: 0,
      kotkaBackCount: 0,
      allPassExchangeIndex: 0,
      bolshevikGivenTo: [],
      bolshevikPasses: 0,
      bolshevikDoubler: null,
      bolshevikAuctionIndex: 0,
      bolshevikBidders: [],
      bolshevikChoiceIndex: 0,
      partnerSignalSuit: { N: null, E: null, S: null, W: null },
      kittyBidderPacket: [],
      kotkaOutPacket: [],
      kotkaBackPacket: [],
    },
    allPassDoublingPasses: 0,
    penalties: buildEmptyPenaltyMap(),
    lastDealDelta: { N: 0, E: 0, S: 0, W: 0 },
    recap: [...rs.recap.slice(-4), "Bolshevik deal annulled (all passed)."],
  };
  events.push({
    type: "announce",
    text: "Bolshevik deal annulled (all passed). Next dealer.",
    anchor: { type: "screen" },
  });
  withUiEvents(state, nextState, events, nextDealer);
  return { valid: true, engineEvents: events };
}

const validate: GameRuleModule["validate"] = (
  state: ValidationState,
  intent: ClientIntent
): ValidationResult => {
  const rs = getRulesState(state.rulesState);
  const currentPlayer = asSeat(state.currentPlayer ?? "");

  if (state.winner) {
    return {
      valid: false,
      reason: "The match is already finished.",
      engineEvents: [],
    };
  }

  if (!isSeat(intent.playerId)) {
    return {
      valid: false,
      reason: "Skruuvi uses seats N, E, S, W.",
      engineEvents: [],
    };
  }
  const actor = intent.playerId as Seat;

  if (rs.phase === "setup" && !rs.hasDealt) {
    if (intent.type !== "action") {
      return {
        valid: false,
        reason: "Use a start action to begin.",
        engineEvents: [],
      };
    }
    if (currentPlayer && actor !== currentPlayer) {
      return {
        valid: false,
        reason: "Only dealer may start.",
        engineEvents: [],
      };
    }
    if (intent.action === "start-game") {
      return buildDealStart(state, rs, "kitty");
    }
    if (intent.action === "start-bolshevik-set") {
      const nextRulesState: SkruuviRulesState = {
        ...rs,
        bolshevik: buildEmptyBolshevikSet(),
      };
      nextRulesState.bolshevik.active = true;
      return buildDealStart(state, nextRulesState, "bolshevik");
    }
    if (intent.action === "start-bolshevik-deal" && rs.bolshevik.active) {
      if (!bolshevikSessionCanContinue(rs)) {
        return {
          valid: false,
          reason: "Bolshevik set is complete.",
          engineEvents: [],
        };
      }
      return buildDealStart(state, rs, "bolshevik");
    }
    return {
      valid: false,
      reason: "Unknown start action.",
      engineEvents: [],
    };
  }

  if (!currentPlayer || actor !== currentPlayer) {
    return { valid: false, reason: "It is not your turn.", engineEvents: [] };
  }

  const events: EngineEvent[] = [];

  if (rs.phase === "play" && intent.type === "action") {
    if (intent.action !== "continue-play") {
      return {
        valid: false,
        reason: "This phase expects card moves, not actions.",
        engineEvents: [],
      };
    }
    if (handCardCount(state, actor) > 0) {
      return {
        valid: false,
        reason: "You still have cards to play.",
        engineEvents: [],
      };
    }

    const trickPlayers = new Set<Seat>(
      rs.round.currentTrick.map((entry) => entry.player)
    );
    const nextWithCards = nextSeatWithCards(state, actor, trickPlayers);

    if (nextWithCards) {
      withUiEvents(state, rs, events, nextWithCards);
      return { valid: true, engineEvents: events };
    }

    if (rs.round.currentTrick.length === 0) {
      finishRound(state, rs, events);
      return { valid: true, engineEvents: events };
    }

    const winner = determineTrickWinner(rs.round.currentTrick, rs.contract);
    let afterTrick = applyRoundTrickProgress(rs, rs.round.currentTrick, winner);
    const tableCardIds = (state.piles.table.cards ?? []).map((c) => c.id);
    if (tableCardIds.length > 0) {
      events.push({
        type: "move-cards",
        fromPileId: "table",
        toPileId: "deck",
        cardIds: tableCardIds as [number, ...number[]],
      });
    }
    events.push({
      type: "announce",
      text: `Trick ${rs.round.trickNumber} won by ${winner}.`,
      anchor: { type: "pile", pileId: "table" },
    });

    const allHandsEmpty = SEATS.every(
      (seat) => handCardCount(state, seat) === 0
    );
    if (allHandsEmpty || afterTrick.round.trickNumber > 13) {
      finishRound(state, afterTrick, events);
      return { valid: true, engineEvents: events };
    }

    afterTrick = { ...afterTrick, round: { ...afterTrick.round } };
    withUiEvents(state, afterTrick, events, winner);
    return { valid: true, engineEvents: events };
  }

  if (intent.type === "action") {
    const availabilityError = validateActionAvailable(state, rs, intent.action);
    if (availabilityError) {
      return { valid: false, reason: availabilityError, engineEvents: [] };
    }

    if (rs.phase === "bolshevik-auction") {
      const order = bolshevikAuctionOrder(rs);
      if (order.length === 0) {
        return {
          valid: false,
          reason: "No eligible Bolshevik declarers remain.",
          engineEvents: [],
        };
      }
      const actorIndex = rs.exchange.bolshevikAuctionIndex;
      const expectedActor = order[actorIndex];
      if (expectedActor !== actor) {
        return {
          valid: false,
          reason: "Bolshevik auction order mismatch.",
          engineEvents: [],
        };
      }

      const nextState: SkruuviRulesState = {
        ...rs,
        auction: { ...rs.auction },
        exchange: { ...rs.exchange },
      };

      if (intent.action !== "pass" && intent.action !== "bolshevik") {
        return {
          valid: false,
          reason: "Use pass or Bolshevik.",
          engineEvents: [],
        };
      }

      if (intent.action === "pass") {
        const forcedOnLast =
          isForcedBolshevikDeal(rs) &&
          actorIndex === order.length - 1 &&
          rs.exchange.bolshevikBidders.length === 0;
        if (forcedOnLast) {
          return {
            valid: false,
            reason:
              "Forced Bolshevik deal: last eligible player must bid Bolshevik.",
            engineEvents: [],
          };
        }
      }

      nextState.auction.history = [
        ...nextState.auction.history,
        { player: actor, call: intent.action },
      ];
      if (intent.action === "bolshevik") {
        nextState.exchange.bolshevikBidders = [
          ...nextState.exchange.bolshevikBidders,
          actor,
        ];
      } else {
        nextState.exchange.bolshevikPasses += 1;
      }
      nextState.exchange.bolshevikAuctionIndex += 1;

      const done = nextState.exchange.bolshevikAuctionIndex >= order.length;
      if (!done) {
        const nextActor = order[nextState.exchange.bolshevikAuctionIndex];
        withUiEvents(state, nextState, events, nextActor);
        return { valid: true, engineEvents: events };
      }

      const bidders = nextState.exchange.bolshevikBidders;
      if (bidders.length === 0) {
        return annulBolshevikDeal(state, nextState, events);
      }

      if (bidders.length === 1) {
        return enterBolshevikBid(
          state,
          nextState,
          events,
          bidders[0],
          `${bidders[0]} bids Bolshevik.`
        );
      }

      const choiceState: SkruuviRulesState = {
        ...nextState,
        phase: "bolshevik-bidder-choice",
        exchange: {
          ...nextState.exchange,
          bolshevikChoiceIndex: 0,
        },
      };
      events.push({
        type: "announce",
        text: `Multiple Bolshevik bids (${bidders.join(", ")}). ${bidders[0]} chooses first.`,
        anchor: { type: "screen" },
      });
      withUiEvents(state, choiceState, events, bidders[0]);
      return { valid: true, engineEvents: events };
    }

    if (rs.phase === "bolshevik-bidder-choice") {
      const bidders = rs.exchange.bolshevikBidders;
      const choiceIndex = rs.exchange.bolshevikChoiceIndex;
      const expected = bidders[choiceIndex];
      if (!expected || expected !== actor) {
        return {
          valid: false,
          reason: "Invalid Bolshevik bidder choice turn.",
          engineEvents: [],
        };
      }
      if (intent.action !== "pass" && intent.action !== "bolshevik") {
        return {
          valid: false,
          reason: "Use pass to withdraw or Bolshevik to declare.",
          engineEvents: [],
        };
      }

      if (intent.action === "bolshevik") {
        return enterBolshevikBid(
          state,
          rs,
          events,
          actor,
          `${actor} keeps Bolshevik declaration.`
        );
      }

      const remaining = bidders.filter((seat) => seat !== actor);
      if (remaining.length === 0) {
        return {
          valid: false,
          reason: "At least one Bolshevik bidder must remain.",
          engineEvents: [],
        };
      }
      if (remaining.length === 1) {
        return enterBolshevikBid(
          state,
          {
            ...rs,
            exchange: {
              ...rs.exchange,
              bolshevikBidders: remaining,
              bolshevikChoiceIndex: 0,
            },
          },
          events,
          remaining[0],
          `${actor} withdraws. ${remaining[0]} becomes Bolshevik declarer.`
        );
      }
      const nextState: SkruuviRulesState = {
        ...rs,
        exchange: {
          ...rs.exchange,
          bolshevikBidders: remaining,
          bolshevikChoiceIndex: 0,
        },
      };
      events.push({
        type: "announce",
        text: `${actor} withdraws Bolshevik bid.`,
        anchor: { type: "screen" },
      });
      withUiEvents(state, nextState, events, remaining[0]);
      return { valid: true, engineEvents: events };
    }

    if (rs.phase === "bolshevik-contract-choice") {
      if (!rs.contract?.declarer) {
        return {
          valid: false,
          reason: "Missing Bolshevik declarer.",
          engineEvents: [],
        };
      }

      const nextContract: Contract = {
        ...rs.contract,
        level: 7,
      };

      if (intent.action === "pass") {
        nextContract.denomination = "misere";
      } else {
        const parsed = parseBidAction(intent.action);
        if (!parsed || parsed.level !== 7 || parsed.denomination === "misere") {
          return {
            valid: false,
            reason: "Choose 7 Misere (pass) or a 7-level suit/grand.",
            engineEvents: [],
          };
        }
        nextContract.denomination = parsed.denomination;
      }

      const [firstDefender] = bolshevikDefenderOrder(rs.contract.declarer);
      const nextState: SkruuviRulesState = {
        ...rs,
        contract: nextContract,
        phase: "bolshevik-doubling",
        exchange: {
          ...rs.exchange,
          bolshevikPasses: 0,
          bolshevikDoubler: null,
          bolshevikAuctionIndex: 0,
          bolshevikBidders: [],
          bolshevikChoiceIndex: 0,
        },
      };
      events.push({
        type: "announce",
        text: `Bolshevik contract: 7 ${denominationLabel(nextContract.denomination)}.`,
        anchor: { type: "screen" },
      });
      withUiEvents(state, nextState, events, firstDefender);
      return { valid: true, engineEvents: events };
    }

    if (rs.phase === "bolshevik-doubling") {
      if (!rs.contract?.declarer) {
        return {
          valid: false,
          reason: "Missing Bolshevik declarer.",
          engineEvents: [],
        };
      }
      const defenders = bolshevikDefenderOrder(rs.contract.declarer);

      if (intent.action === "double") {
        const doubled: SkruuviRulesState = {
          ...rs,
          phase: "bolshevik-redouble",
          contract: {
            ...rs.contract,
            multiplier: 2,
            doubledBy: actor,
          },
          exchange: { ...rs.exchange, bolshevikDoubler: actor },
        };
        events.push({
          type: "announce",
          text: `${actor} doubles Bolshevik.`,
          anchor: { type: "screen" },
        });
        withUiEvents(state, doubled, events, rs.contract.declarer);
        return { valid: true, engineEvents: events };
      }

      if (intent.action !== "pass") {
        return {
          valid: false,
          reason: "Use pass or double.",
          engineEvents: [],
        };
      }

      const passes = rs.exchange.bolshevikPasses + 1;
      if (passes >= 3) {
        enterPlayPhase(state, rs, events, defenders[0]);
        return { valid: true, engineEvents: events };
      }
      const nextState: SkruuviRulesState = {
        ...rs,
        exchange: { ...rs.exchange, bolshevikPasses: passes },
      };
      withUiEvents(state, nextState, events, defenders[passes]);
      return { valid: true, engineEvents: events };
    }

    if (rs.phase === "bolshevik-redouble") {
      if (!rs.contract?.declarer) {
        return {
          valid: false,
          reason: "Missing Bolshevik declarer.",
          engineEvents: [],
        };
      }
      const [openingLeader] = bolshevikDefenderOrder(rs.contract.declarer);
      if (intent.action === "redouble") {
        const redoubled: SkruuviRulesState = {
          ...rs,
          contract: {
            ...rs.contract,
            multiplier: 3,
            redoubledBy: actor,
          },
        };
        events.push({
          type: "announce",
          text: `${actor} redoubles Bolshevik.`,
          anchor: { type: "screen" },
        });
        enterPlayPhase(state, redoubled, events, openingLeader);
        return { valid: true, engineEvents: events };
      }
      if (intent.action !== "pass") {
        return {
          valid: false,
          reason: "Use pass or redouble.",
          engineEvents: [],
        };
      }
      enterPlayPhase(state, rs, events, openingLeader);
      return { valid: true, engineEvents: events };
    }

    if (rs.phase === "auction") {
      if (!rs.mode) {
        return { valid: false, reason: "Mode missing.", engineEvents: [] };
      }
      const nextRulesState: SkruuviRulesState = {
        ...rs,
        auction: { ...rs.auction },
      };

      nextRulesState.auction.totalCalls += 1;

      if (intent.action === "pass") {
        nextRulesState.auction.history = [
          ...nextRulesState.auction.history,
          { player: actor, call: "pass" },
        ];
        nextRulesState.auction.consecutivePasses += 1;

        const allPassFirstRound =
          nextRulesState.auction.highestBid === null &&
          nextRulesState.auction.totalCalls === 4 &&
          nextRulesState.auction.consecutivePasses === 4;

        if (allPassFirstRound) {
          const mode = nextRulesState.mode!;
          const contract: Contract = {
            level: 0,
            denomination: "misere",
            declarer: null,
            side: null,
            multiplier: 1,
            doubledBy: null,
            redoubledBy: null,
            allPass: true,
          };
          const afterAllPass: SkruuviRulesState = {
            ...nextRulesState,
            contract,
            phase: "all-pass-exchange",
            exchange: { ...nextRulesState.exchange, allPassExchangeIndex: 0 },
            allPassDoublingPasses: 0,
            recap: [
              ...nextRulesState.recap,
              "All players passed. All-pass Misere.",
            ],
          };

          if (mode === "kitty") {
            const kittyCards =
              state.piles.deck.cards?.map((card) => card.id) ?? [];
            if (kittyCards.length !== 4) {
              return {
                valid: false,
                reason: "Kitty must contain 4 cards in all-pass kitty game.",
                engineEvents: [],
              };
            }
            const order: Seat[] = [];
            let seat = nextSeat(afterAllPass.dealer);
            for (let i = 0; i < 4; i++) {
              order.push(seat);
              seat = nextSeat(seat);
            }
            for (let i = 0; i < 4; i++) {
              events.push({
                type: "move-cards",
                fromPileId: "deck",
                toPileId: `${order[i]}-hand`,
                cardIds: [kittyCards[i]],
              });
            }
          }

          const step = getAllPassExchangeSteps(
            afterAllPass.dealer,
            afterAllPass.dealNumber
          )[0];
          events.push({
            type: "announce",
            text: "All-pass Misere: exchange one card with partner.",
            anchor: { type: "screen" },
          });
          withUiEvents(state, afterAllPass, events, step.actor);
          return { valid: true, engineEvents: events };
        }

        if (
          nextRulesState.auction.highestBid &&
          nextRulesState.auction.consecutivePasses >= 8
        ) {
          const highest = nextRulesState.auction.highestBid;
          const bidder = highest.bidder;
          const partner = partnerOfForDeal(nextRulesState.dealNumber, bidder);
          const mode = nextRulesState.mode!;

          const afterAuction: SkruuviRulesState = {
            ...nextRulesState,
            mainPlayers: { bidder, partner },
            contract: {
              level: highest.level,
              denomination: highest.denomination,
              declarer: bidder,
              side: sideOfForDeal(nextRulesState.dealNumber, bidder),
              multiplier: 1,
              doubledBy: null,
              redoubledBy: null,
              allPass: false,
            },
            exchange: {
              ...nextRulesState.exchange,
              bidderPassedCount: 0,
              partnerGivenTo: [],
              kotkaOutCount: 0,
              kotkaBackCount: 0,
            },
          };

          events.push({
            type: "announce",
            text: `Kitty bid: ${bidLabel(highest)}.`,
            anchor: { type: "screen" },
          });

          if (mode === "kitty") {
            const kittyCards =
              state.piles.deck.cards?.map((card) => card.id) ?? [];
            if (kittyCards.length !== 4) {
              return {
                valid: false,
                reason: "Kitty must contain 4 cards.",
                engineEvents: [],
              };
            }
            events.push({
              type: "move-cards",
              fromPileId: "deck",
              toPileId: "table",
              cardIds: kittyCards as [number, ...number[]],
            });
            events.push({
              type: "announce",
              text: "Kitty is revealed.",
              anchor: { type: "pile", pileId: "table" },
            });
            events.push({
              type: "move-cards",
              fromPileId: "table",
              toPileId: `${bidder}-hand`,
              cardIds: kittyCards as [number, ...number[]],
            });
            const afterKitty = {
              ...afterAuction,
              phase: "kitty-bidder-pass4" as SkruuviPhase,
            };
            withUiEvents(state, afterKitty, events, bidder);
            return { valid: true, engineEvents: events };
          }

          const afterKotka = {
            ...afterAuction,
            phase: "kotka-pass4-out" as SkruuviPhase,
          };
          withUiEvents(state, afterKotka, events, bidder);
          return { valid: true, engineEvents: events };
        }

        const nextPlayer = nextSeat(actor);
        withUiEvents(state, nextRulesState, events, nextPlayer);
        return { valid: true, engineEvents: events };
      }

      const parsed = parseBidAction(intent.action);
      if (!parsed) {
        return {
          valid: false,
          reason: "Invalid bid action.",
          engineEvents: [],
        };
      }
      const bid: Bid = { ...parsed, bidder: actor };
      if (
        nextRulesState.auction.highestBid &&
        compareBids(rs.mode, bid, nextRulesState.auction.highestBid) <= 0
      ) {
        return {
          valid: false,
          reason: "Bid is not high enough.",
          engineEvents: [],
        };
      }
      if (
        nextRulesState.auction.highestBid === null &&
        rs.mode === "kotka" &&
        bid.level < 6
      ) {
        return {
          valid: false,
          reason: "Opening bid in Kotka must be at least level 6.",
          engineEvents: [],
        };
      }

      nextRulesState.auction.history = [
        ...nextRulesState.auction.history,
        { player: actor, call: `${bid.level}-${bid.denomination}` },
      ];
      nextRulesState.auction.highestBid = bid;
      nextRulesState.auction.consecutivePasses = 0;
      if (nextRulesState.auction.firstBidLevel === null) {
        nextRulesState.auction.firstBidLevel = bid.level;
      }

      const nextPlayer = nextSeat(actor);
      withUiEvents(state, nextRulesState, events, nextPlayer);
      return { valid: true, engineEvents: events };
    }

    if (rs.phase === "extended-bidding") {
      if (!rs.mode || !rs.mainPlayers || !rs.auction.highestBid) {
        return {
          valid: false,
          reason: "Extended bidding state is invalid.",
          engineEvents: [],
        };
      }

      const otherMain =
        actor === rs.mainPlayers.bidder
          ? rs.mainPlayers.partner
          : rs.mainPlayers.bidder;
      const nextRulesState: SkruuviRulesState = {
        ...rs,
        auction: { ...rs.auction },
      };

      if (intent.action === "pass") {
        nextRulesState.auction.history = [
          ...nextRulesState.auction.history,
          { player: actor, call: "pass" },
        ];
        nextRulesState.auction.consecutivePasses += 1;

        if (nextRulesState.auction.consecutivePasses >= 4) {
          const finalBid = nextRulesState.auction.highestBid;
          if (!finalBid) {
            return {
              valid: false,
              reason: "Final bid is missing.",
              engineEvents: [],
            };
          }
          const minLevel = contractMinLevel(rs.mode);
          if (finalBid.level < minLevel) {
            return {
              valid: false,
              reason: `Final contract must be at least level ${minLevel}.`,
              engineEvents: [],
            };
          }
          const declarer = finalBid.bidder;
          const nextContract: Contract = {
            level: finalBid.level,
            denomination: finalBid.denomination,
            declarer,
            side: sideOfForDeal(nextRulesState.dealNumber, declarer),
            multiplier: 1,
            doubledBy: null,
            redoubledBy: null,
            allPass: false,
          };
          const afterBidding: SkruuviRulesState = {
            ...nextRulesState,
            contract: nextContract,
            recap: [
              ...nextRulesState.recap,
              `Contract: ${bidLabel(finalBid)}.`,
            ],
          };

          events.push({
            type: "announce",
            text: `Final contract: ${bidLabel(finalBid)}.`,
            anchor: { type: "screen" },
          });

          const defenderExchangeAllowed =
            afterBidding.mode === "kitty" &&
            (afterBidding.auction.firstBidLevel ?? 7) < 6;

          if (defenderExchangeAllowed) {
            const [leftDef] = defendersClockwiseFrom(
              declarer,
              partnerOfForDeal(nextRulesState.dealNumber, declarer)
            );
            const afterExchange = {
              ...afterBidding,
              phase: "defender-exchange-out" as SkruuviPhase,
            };
            withUiEvents(state, afterExchange, events, leftDef);
            return { valid: true, engineEvents: events };
          }

          const [firstDefender] = defendersClockwiseFrom(
            declarer,
            partnerOfForDeal(nextRulesState.dealNumber, declarer)
          );
          const afterDoubles = {
            ...afterBidding,
            phase: "doubling-def-left" as SkruuviPhase,
          };
          withUiEvents(state, afterDoubles, events, firstDefender);
          return { valid: true, engineEvents: events };
        }

        withUiEvents(state, nextRulesState, events, otherMain);
        return { valid: true, engineEvents: events };
      }

      const parsed = parseBidAction(intent.action);
      if (!parsed) {
        return {
          valid: false,
          reason: "Invalid bid action.",
          engineEvents: [],
        };
      }
      const bid: Bid = { ...parsed, bidder: actor };
      if (compareBids(rs.mode, bid, rs.auction.highestBid) <= 0) {
        return {
          valid: false,
          reason: "Bid is not high enough.",
          engineEvents: [],
        };
      }

      nextRulesState.auction.history = [
        ...nextRulesState.auction.history,
        { player: actor, call: `${bid.level}-${bid.denomination}` },
      ];
      nextRulesState.auction.highestBid = bid;
      nextRulesState.auction.consecutivePasses = 0;

      withUiEvents(state, nextRulesState, events, otherMain);
      return { valid: true, engineEvents: events };
    }

    if (rs.phase === "doubling-def-left" || rs.phase === "doubling-def-right") {
      if (
        !rs.contract ||
        rs.contract.allPass ||
        rs.contract.declarer === null
      ) {
        return {
          valid: false,
          reason: "No declarer contract.",
          engineEvents: [],
        };
      }
      const declarer = rs.contract.declarer;
      const partner =
        rs.mainPlayers?.partner ?? partnerOfForDeal(rs.dealNumber, declarer);
      const bidder = rs.mainPlayers?.bidder ?? declarer;
      const [firstDefender, secondDefender] = defendersClockwiseFrom(
        declarer,
        partner
      );

      if (intent.action === "double") {
        const doubled: SkruuviRulesState = {
          ...rs,
          phase: "redouble-first",
          contract: {
            ...rs.contract,
            multiplier: 2,
            doubledBy: actor,
          },
        };
        const redoubler1 = nextMainClockwiseFrom(actor, bidder, partner);
        if (!redoubler1) {
          return {
            valid: false,
            reason: "Main players missing for redouble.",
            engineEvents: [],
          };
        }
        events.push({
          type: "announce",
          text: `${actor} doubles.`,
          anchor: { type: "screen" },
        });
        withUiEvents(state, doubled, events, redoubler1);
        return { valid: true, engineEvents: events };
      }

      if (intent.action !== "pass") {
        return {
          valid: false,
          reason: "Use pass or double.",
          engineEvents: [],
        };
      }

      if (rs.phase === "doubling-def-left") {
        const nextState = {
          ...rs,
          phase: "doubling-def-right" as SkruuviPhase,
        };
        withUiEvents(state, nextState, events, secondDefender);
        return { valid: true, engineEvents: events };
      }

      enterPlayPhase(state, rs, events, firstDefender);
      return { valid: true, engineEvents: events };
    }

    if (rs.phase === "redouble-first" || rs.phase === "redouble-second") {
      if (
        !rs.contract ||
        rs.contract.declarer === null ||
        !rs.contract.doubledBy
      ) {
        return { valid: false, reason: "No active double.", engineEvents: [] };
      }
      const declarer = rs.contract.declarer;
      const partner =
        rs.mainPlayers?.partner ?? partnerOfForDeal(rs.dealNumber, declarer);
      const bidder = rs.mainPlayers?.bidder ?? declarer;
      const [openingLeader] = defendersClockwiseFrom(declarer, partner);
      if (intent.action === "redouble") {
        const redoubled: SkruuviRulesState = {
          ...rs,
          contract: {
            ...rs.contract,
            multiplier: 3,
            redoubledBy: actor,
          },
        };
        events.push({
          type: "announce",
          text: `${actor} redoubles.`,
          anchor: { type: "screen" },
        });
        enterPlayPhase(state, redoubled, events, openingLeader);
        return { valid: true, engineEvents: events };
      }

      if (intent.action !== "pass") {
        return {
          valid: false,
          reason: "Use pass or redouble.",
          engineEvents: [],
        };
      }

      if (rs.phase === "redouble-first") {
        const nextRedoubler = nextMainClockwiseFrom(actor, bidder, partner);
        if (!nextRedoubler) {
          return {
            valid: false,
            reason: "Main players missing.",
            engineEvents: [],
          };
        }
        const nextState = { ...rs, phase: "redouble-second" as SkruuviPhase };
        withUiEvents(state, nextState, events, nextRedoubler);
        return { valid: true, engineEvents: events };
      }

      enterPlayPhase(state, rs, events, openingLeader);
      return { valid: true, engineEvents: events };
    }

    if (rs.phase === "all-pass-doubling") {
      if (!rs.contract || !rs.contract.allPass) {
        return { valid: false, reason: "Not in all-pass.", engineEvents: [] };
      }
      if (intent.action === "double") {
        const doubled: SkruuviRulesState = {
          ...rs,
          phase: "all-pass-redouble-first",
          contract: {
            ...rs.contract,
            multiplier: 2,
            doubledBy: actor,
          },
          allPassDoublingPasses: 0,
        };
        events.push({
          type: "announce",
          text: `${actor} doubles all-pass.`,
          anchor: { type: "screen" },
        });
        withUiEvents(state, doubled, events, nextSeat(actor));
        return { valid: true, engineEvents: events };
      }

      if (intent.action !== "pass") {
        return {
          valid: false,
          reason: "Use pass or double.",
          engineEvents: [],
        };
      }
      const nextPasses = rs.allPassDoublingPasses + 1;
      if (nextPasses >= 4) {
        enterPlayPhase(state, rs, events, nextSeat(rs.dealer));
        return { valid: true, engineEvents: events };
      }
      const nextState: SkruuviRulesState = {
        ...rs,
        allPassDoublingPasses: nextPasses,
      };
      withUiEvents(state, nextState, events, nextSeat(actor));
      return { valid: true, engineEvents: events };
    }

    if (
      rs.phase === "all-pass-redouble-first" ||
      rs.phase === "all-pass-redouble-second"
    ) {
      if (!rs.contract || !rs.contract.allPass || !rs.contract.doubledBy) {
        return {
          valid: false,
          reason: "No active all-pass double.",
          engineEvents: [],
        };
      }
      if (intent.action === "redouble") {
        const redoubled: SkruuviRulesState = {
          ...rs,
          contract: {
            ...rs.contract,
            multiplier: 3,
            redoubledBy: actor,
          },
        };
        events.push({
          type: "announce",
          text: `${actor} redoubles all-pass.`,
          anchor: { type: "screen" },
        });
        enterPlayPhase(state, redoubled, events, nextSeat(rs.dealer));
        return { valid: true, engineEvents: events };
      }

      if (intent.action !== "pass") {
        return {
          valid: false,
          reason: "Use pass or redouble.",
          engineEvents: [],
        };
      }

      if (rs.phase === "all-pass-redouble-first") {
        const nextState = {
          ...rs,
          phase: "all-pass-redouble-second" as SkruuviPhase,
        };
        withUiEvents(state, nextState, events, prevSeat(rs.contract.doubledBy));
        return { valid: true, engineEvents: events };
      }

      enterPlayPhase(state, rs, events, nextSeat(rs.dealer));
      return { valid: true, engineEvents: events };
    }

    return {
      valid: false,
      reason: "This phase expects card moves, not actions.",
      engineEvents: [],
    };
  }

  if (intent.type !== "move") {
    return {
      valid: false,
      reason: "Unsupported intent type.",
      engineEvents: [],
    };
  }

  const fromExpected = `${actor}-hand`;
  if (intent.fromPileId !== fromExpected) {
    return {
      valid: false,
      reason: "You must move a card from your own hand.",
      engineEvents: [],
    };
  }

  const legalTargets = legalMoveTargetsForCurrentPhase(rs, actor);
  if (!legalTargets.includes(intent.toPileId)) {
    return {
      valid: false,
      reason: "That move target is not legal in this phase.",
      engineEvents: [],
    };
  }

  const moveCardId = intent.cardId ?? intent.cardIds?.[0];
  if (moveCardId === undefined) {
    return {
      valid: false,
      reason: "Move is missing card id.",
      engineEvents: [],
    };
  }

  const card = getCardFromPile(state, fromExpected, moveCardId);
  if (!card) {
    return {
      valid: false,
      reason: "Card not found in your hand.",
      engineEvents: [],
    };
  }

  let postMovePenalty: InfractionPenalty | null = null;

  if (rs.phase === "kitty-partner-distribute3") {
    const targetSeat = asSeat(intent.toPileId.replace(/-hand$/, ""));
    if (!targetSeat) {
      return { valid: false, reason: "Invalid target hand.", engineEvents: [] };
    }
    if (rs.exchange.partnerGivenTo.includes(targetSeat)) {
      return {
        valid: false,
        reason: "You already gave a card to that player.",
        engineEvents: [],
      };
    }
  }

  if (rs.phase === "all-pass-exchange") {
    const steps = getAllPassExchangeSteps(rs.dealer, rs.dealNumber);
    const step = steps[rs.exchange.allPassExchangeIndex];
    if (
      !step ||
      step.actor !== actor ||
      intent.toPileId !== `${step.target}-hand`
    ) {
      return {
        valid: false,
        reason: "This all-pass exchange move is out of sequence.",
        engineEvents: [],
      };
    }
  }

  if (rs.phase === "play") {
    const currentTrick = rs.round.currentTrick;
    if (intent.toPileId !== "table") {
      return {
        valid: false,
        reason: "Play cards to the table pile.",
        engineEvents: [],
      };
    }
    if (currentTrick.length > 0) {
      const leadSuit = currentTrick[0].suit;
      if (card.suit !== leadSuit) {
        const hasLeadSuit = state.piles[fromExpected].cards?.some(
          (c) => c.suit === leadSuit
        );
        if (hasLeadSuit) {
          return {
            valid: false,
            reason: `Must follow suit (${getSuitSymbol(leadSuit)}).`,
            engineEvents: [],
          };
        }
      }
    }

    if (
      rs.mode !== "bolshevik" &&
      currentTrick.length === 0 &&
      rs.contract?.doubledBy &&
      partnerOfForDeal(rs.dealNumber, actor) === rs.contract.doubledBy
    ) {
      const requiredSuit = rs.exchange.partnerSignalSuit[actor];
      if (requiredSuit && card.suit !== requiredSuit) {
        postMovePenalty = {
          seat: actor,
          points: 5,
          text: `Opening-lead signal violation by ${actor}: partner doubled and signaled ${getSuitSymbol(requiredSuit)}.`,
        };
      }
    }
  }

  events.push({
    type: "move-cards",
    fromPileId: intent.fromPileId,
    toPileId: intent.toPileId,
    cardIds: [moveCardId],
  });

  if (rs.phase === "kitty-bidder-pass4") {
    const count = rs.exchange.bidderPassedCount + 1;
    const packet = [...rs.exchange.kittyBidderPacket, card.id];
    let nextState: SkruuviRulesState = {
      ...rs,
      exchange: {
        ...rs.exchange,
        bidderPassedCount: count,
        kittyBidderPacket: packet,
      },
    };
    if (count >= 4 && !isPacketConventionCompliant(state, packet)) {
      nextState = withInfractionPenalty(
        nextState,
        {
          seat: actor,
          points: 5,
          text: `Kitty packet by ${actor} is convention-invalid.`,
        },
        events
      );
    }
    if (count >= 4) {
      nextState.phase = "kitty-partner-distribute3";
      events.push({
        type: "announce",
        text: "Kitty partner distributes one card to each other player.",
        anchor: { type: "screen" },
      });
      withUiEvents(state, nextState, events, rs.mainPlayers!.partner);
      return { valid: true, engineEvents: events };
    }
    withUiEvents(state, nextState, events, actor);
    return { valid: true, engineEvents: events };
  }

  if (rs.phase === "kitty-partner-distribute3") {
    const targetSeat = asSeat(intent.toPileId.replace(/-hand$/, ""));
    const nextGiven = [...rs.exchange.partnerGivenTo, targetSeat!];
    const nextState: SkruuviRulesState = {
      ...rs,
      exchange: { ...rs.exchange, partnerGivenTo: nextGiven },
    };
    if (nextGiven.length >= 3) {
      nextState.phase = "extended-bidding";
      nextState.auction.consecutivePasses = 0;
      withUiEvents(state, nextState, events, rs.mainPlayers!.bidder);
      return { valid: true, engineEvents: events };
    }
    withUiEvents(state, nextState, events, actor);
    return { valid: true, engineEvents: events };
  }

  if (rs.phase === "kotka-pass4-out") {
    const count = rs.exchange.kotkaOutCount + 1;
    const packet = [...rs.exchange.kotkaOutPacket, card.id];
    let nextState: SkruuviRulesState = {
      ...rs,
      exchange: {
        ...rs.exchange,
        kotkaOutCount: count,
        kotkaOutPacket: packet,
      },
    };
    if (count >= 4 && !isPacketConventionCompliant(state, packet)) {
      nextState = withInfractionPenalty(
        nextState,
        {
          seat: actor,
          points: 5,
          text: `Kotka outbound packet by ${actor} is convention-invalid.`,
        },
        events
      );
    }
    if (count >= 4) {
      nextState.phase = "kotka-pass4-back";
      withUiEvents(state, nextState, events, rs.mainPlayers!.partner);
      return { valid: true, engineEvents: events };
    }
    withUiEvents(state, nextState, events, actor);
    return { valid: true, engineEvents: events };
  }

  if (rs.phase === "kotka-pass4-back") {
    const count = rs.exchange.kotkaBackCount + 1;
    const packet = [...rs.exchange.kotkaBackPacket, card.id];
    let nextState: SkruuviRulesState = {
      ...rs,
      exchange: {
        ...rs.exchange,
        kotkaBackCount: count,
        kotkaBackPacket: packet,
      },
    };
    if (count >= 4 && !isPacketConventionCompliant(state, packet)) {
      nextState = withInfractionPenalty(
        nextState,
        {
          seat: actor,
          points: 5,
          text: `Kotka return packet by ${actor} is convention-invalid.`,
        },
        events
      );
    }
    if (count >= 4) {
      nextState.phase = "extended-bidding";
      nextState.auction.consecutivePasses = 0;
      withUiEvents(state, nextState, events, rs.mainPlayers!.bidder);
      return { valid: true, engineEvents: events };
    }
    withUiEvents(state, nextState, events, actor);
    return { valid: true, engineEvents: events };
  }

  if (rs.phase === "defender-exchange-out") {
    const targetSeat = asSeat(intent.toPileId.replace(/-hand$/, ""));
    if (!targetSeat) {
      return { valid: false, reason: "Invalid target hand.", engineEvents: [] };
    }
    const nextState: SkruuviRulesState = {
      ...rs,
      phase: "defender-exchange-back",
      exchange: {
        ...rs.exchange,
        partnerSignalSuit: {
          ...rs.exchange.partnerSignalSuit,
          [targetSeat]: card.suit,
        },
      },
    };
    withUiEvents(
      state,
      nextState,
      events,
      partnerOfForDeal(rs.dealNumber, actor)
    );
    return { valid: true, engineEvents: events };
  }

  if (rs.phase === "defender-exchange-back") {
    const targetSeat = asSeat(intent.toPileId.replace(/-hand$/, ""));
    if (!targetSeat) {
      return { valid: false, reason: "Invalid target hand.", engineEvents: [] };
    }
    const nextState: SkruuviRulesState = {
      ...rs,
      phase: "doubling-def-left",
      exchange: {
        ...rs.exchange,
        partnerSignalSuit: {
          ...rs.exchange.partnerSignalSuit,
          [targetSeat]: card.suit,
        },
      },
    };
    const declarer = rs.contract!.declarer!;
    const partner = partnerOfForDeal(rs.dealNumber, declarer);
    const [firstDefender] = defendersClockwiseFrom(declarer, partner);
    withUiEvents(state, nextState, events, firstDefender);
    return { valid: true, engineEvents: events };
  }

  if (rs.phase === "bolshevik-bidder-distribute3") {
    const targetSeat = asSeat(intent.toPileId.replace(/-hand$/, ""));
    const givenTo = [...rs.exchange.bolshevikGivenTo];

    if (targetSeat) {
      if (givenTo.includes(targetSeat)) {
        return {
          valid: false,
          reason: "You already gave a card to that defender.",
          engineEvents: [],
        };
      }
      givenTo.push(targetSeat);
    }

    const nextState: SkruuviRulesState = {
      ...rs,
      exchange: {
        ...rs.exchange,
        bolshevikGivenTo: givenTo,
      },
    };
    const done = givenTo.length >= 3;
    if (done) {
      nextState.phase = "bolshevik-contract-choice";
      withUiEvents(state, nextState, events, rs.contract!.declarer);
      return { valid: true, engineEvents: events };
    }
    withUiEvents(state, nextState, events, actor);
    return { valid: true, engineEvents: events };
  }

  if (rs.phase === "all-pass-exchange") {
    const step = getAllPassExchangeSteps(rs.dealer, rs.dealNumber)[
      rs.exchange.allPassExchangeIndex
    ];
    if (!step) {
      return {
        valid: false,
        reason: "All-pass exchange step is out of range.",
        engineEvents: [],
      };
    }
    const nextIndex = rs.exchange.allPassExchangeIndex + 1;
    const nextState: SkruuviRulesState = {
      ...rs,
      exchange: {
        ...rs.exchange,
        allPassExchangeIndex: nextIndex,
        partnerSignalSuit: {
          ...rs.exchange.partnerSignalSuit,
          [step.target]: card.suit,
        },
      },
    };
    if (nextIndex >= 4) {
      nextState.phase = "all-pass-doubling";
      nextState.allPassDoublingPasses = 0;
      withUiEvents(state, nextState, events, rs.dealer);
      return { valid: true, engineEvents: events };
    }
    const nextActor = getAllPassExchangeSteps(rs.dealer, rs.dealNumber)[
      nextIndex
    ].actor;
    withUiEvents(state, nextState, events, nextActor);
    return { valid: true, engineEvents: events };
  }

  if (rs.phase === "play") {
    const trickCards = [
      ...rs.round.currentTrick,
      {
        cardId: card.id,
        player: actor,
        rank: card.rank,
        suit: card.suit,
      },
    ];

    if (trickCards.length < 4) {
      let nextState: SkruuviRulesState = {
        ...rs,
        round: { ...rs.round, currentTrick: trickCards },
      };
      nextState = withInfractionPenalty(nextState, postMovePenalty, events);
      withUiEvents(state, nextState, events, nextSeat(actor));
      return { valid: true, engineEvents: events };
    }

    const winner = determineTrickWinner(trickCards, rs.contract);
    let afterTrick = applyRoundTrickProgress(rs, trickCards, winner);
    afterTrick = withInfractionPenalty(afterTrick, postMovePenalty, events);
    const tableCardIds = (state.piles.table.cards ?? []).map((c) => c.id);
    const orderedIds = [...tableCardIds, card.id];
    events.push({
      type: "move-cards",
      fromPileId: "table",
      toPileId: "deck",
      cardIds: orderedIds as [number, ...number[]],
    });
    events.push({
      type: "announce",
      text: `Trick ${rs.round.trickNumber} won by ${winner}.`,
      anchor: { type: "pile", pileId: "table" },
    });

    if (afterTrick.round.trickNumber > 13) {
      finishRound(state, afterTrick, events);
      return { valid: true, engineEvents: events };
    }

    withUiEvents(state, afterTrick, events, winner);
    return { valid: true, engineEvents: events };
  }

  return {
    valid: false,
    reason: "Illegal move for this phase.",
    engineEvents: [],
  };
};

const listLegalIntentsForPlayer: GameRuleModule["listLegalIntentsForPlayer"] = (
  state: ValidationState,
  playerId: string
) => {
  const rs = getRulesState(state.rulesState);
  const gameId = state.gameId;
  if (!isSeat(playerId)) return [];
  const seat = playerId as Seat;
  const intents: ClientIntent[] = [];

  const current = asSeat(state.currentPlayer ?? "");
  const canActInSetup =
    rs.phase === "setup" && !state.winner && (!current || current === seat);
  if (canActInSetup) {
    const setupActions = [
      "start-game",
      "start-bolshevik-set",
      "start-bolshevik-deal",
    ];
    for (const action of setupActions) {
      const candidate: ClientIntent = {
        type: "action",
        gameId,
        playerId: seat,
        action,
      };
      if (validate(state, candidate).valid) intents.push(candidate);
    }
    return intents;
  }

  if (state.winner || current !== seat) return [];

  const actionPhases = new Set<SkruuviPhase>([
    "auction",
    "extended-bidding",
    "doubling-def-left",
    "doubling-def-right",
    "redouble-first",
    "redouble-second",
    "all-pass-doubling",
    "all-pass-redouble-first",
    "all-pass-redouble-second",
    "bolshevik-auction",
    "bolshevik-bidder-choice",
    "bolshevik-contract-choice",
    "bolshevik-doubling",
    "bolshevik-redouble",
  ]);

  if (actionPhases.has(rs.phase)) {
    const possibleActions = [
      "pass",
      "double",
      "redouble",
      "bolshevik",
      ...Array.from({ length: 7 }, (_, i) =>
        ["misere", "spades", "clubs", "diamonds", "hearts", "grand"].map(
          (denom) => bidActionId(i + 1, denom as Denomination)
        )
      ).flat(),
    ];

    for (const action of possibleActions) {
      const candidate: ClientIntent = {
        type: "action",
        gameId,
        playerId: seat,
        action,
      };
      if (validate(state, candidate).valid) intents.push(candidate);
    }
    return intents;
  }

  const handPileId = `${seat}-hand`;
  const hand = state.piles[handPileId];
  if (!hand?.cards || hand.cards.length === 0) {
    if (rs.phase === "play") {
      const candidate: ClientIntent = {
        type: "action",
        gameId,
        playerId: seat,
        action: "continue-play",
      };
      if (validate(state, candidate).valid) intents.push(candidate);
    }
    return intents;
  }

  const targets = legalMoveTargetsForCurrentPhase(rs, seat);
  for (const targetPileId of targets) {
    for (const card of hand.cards) {
      const candidate: ClientIntent = {
        type: "move",
        gameId,
        playerId: seat,
        fromPileId: handPileId,
        toPileId: targetPileId,
        cardId: card.id,
      };
      if (validate(state, candidate).valid) intents.push(candidate);
    }
  }

  return intents;
};

export const skruuviRules: GameRuleModule = {
  validate,
  listLegalIntentsForPlayer,
};

export const skruuviPlugin: GamePlugin = {
  id: "skruuvi",
  gameName: META.gameName,
  ruleModule: skruuviRules,
  description: META.description,
  validationHints: {
    sharedPileIds: ["deck", "table"],
    isPileAlwaysVisibleToRules: (pileId) => pileId.endsWith("-hand"),
  },
};
