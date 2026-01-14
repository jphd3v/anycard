/**
 * Canonical Rubber Bridge rules (deterministic TypeScript implementation).
 *
 * Implements full rubber scoring, bidding (with redouble), and trick-play.
 */
import type { GameRuleModule, GamePlugin } from "../interface.js";
import type { ValidationState } from "../../validation-state.js";
import type {
  ActionCell,
  ActionGrid,
  ClientIntent,
  GameState,
  Scoreboard,
} from "../../../../shared/schemas.js";
import type {
  EngineEvent,
  ValidationResult,
} from "../../../../shared/validation.js";
import { loadGameMeta } from "../meta.js";
import { getSuitSymbol } from "../../util/card-notation.js";
import type { AiView, AiContext } from "../../../../shared/src/ai/types.js";
import { projectPilesAfterEvents, type ProjectedPiles } from "../util/piles.js";
import {
  gatherAllCards,
  shuffleAllCards,
  distributeRoundRobin,
} from "../util/dealing.js";

const META = loadGameMeta("bridge");

type BridgePhase = "bidding" | "play";
type Denomination = "clubs" | "diamonds" | "hearts" | "spades" | "no-trump";
type Partnership = "NS" | "EW";
type BridgeSeat = "N" | "E" | "S" | "W";

interface BridgeBid {
  level: number;
  denomination: Denomination;
  bidder: string;
  doubled?: boolean;
  redoubled?: boolean;
}

interface BridgeRulesState {
  hasDealt?: boolean;
  dealNumber: number;
  dealerSeat: BridgeSeat;
  phase: BridgePhase;
  bidding: {
    history: Array<{ player: string; call: string }>;
    highestBid: BridgeBid | null;
    passesInRow: number;
  };
  contract: {
    level: number;
    trumpSuit: Denomination;
    declarer: string;
    declarerSide: Partnership;
    targetTricks: number;
    doubled: boolean;
    redoubled: boolean;
  } | null;
  play: {
    dummySeat: string;
    turnSeat: string;
    dummyRevealed: boolean;
  } | null;
  currentTrick: {
    cards: Array<{
      cardId: number;
      player: string;
      suit: string;
      rank: string;
    }>;
    leadSuit: string | null;
  };
  currentTrickNumber: number;
  trickLeader?: string;
  tricksNS: number;
  tricksEW: number;
  // Rubber Bridge Persistence
  aboveNS: number;
  belowNS: number;
  aboveEW: number;
  belowEW: number;
  gamesNS: number;
  gamesEW: number;
  rubberFinished: boolean;
  result: string | null;
  // Recap log for AI context (modern approach)
  recap: string[];
}

const BID_LEVELS = [1, 2, 3, 4, 5, 6, 7] as const;
const BID_DENOMS: Denomination[] = [
  "clubs",
  "diamonds",
  "hearts",
  "spades",
  "no-trump",
];
const NEXT_PLAYER: Record<BridgeSeat, BridgeSeat> = {
  N: "E",
  E: "S",
  S: "W",
  W: "N",
};
const RANK_ORDER = [
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
  "A",
] as const;

function partnership(playerId?: string | null): Partnership | null {
  if (!playerId) return null;
  return playerId === "N" || playerId === "S"
    ? "NS"
    : playerId === "E" || playerId === "W"
      ? "EW"
      : null;
}

function partnerSeat(playerId: string): string | null {
  if (playerId === "N") return "S";
  if (playerId === "S") return "N";
  if (playerId === "E") return "W";
  if (playerId === "W") return "E";
  return null;
}

function toBridgeSeat(seat: string | null): BridgeSeat | null {
  if (seat === "N" || seat === "E" || seat === "S" || seat === "W") {
    return seat;
  }
  return null;
}

function decisionMakerForSeat(
  seatToPlay: string,
  declarer: string,
  dummySeat: string
): string {
  return seatToPlay === dummySeat ? declarer : seatToPlay;
}

function formatBid(level: number, denom: Denomination): string {
  const symbol = denom === "no-trump" ? "NT" : getSuitSymbol(denom);
  return `${level}${symbol}`;
}

function parseBid(
  call: string
): { level: number; denomination: Denomination } | null {
  const m = call.match(/^([1-7])\s*(♣️|♦️|♥️|♠️|NT|nt|C|D|H|S|N)$/i);
  if (!m) return null;
  const level = Number(m[1]);
  const suitStr = m[2].toUpperCase();

  let denom: Denomination;
  if (suitStr.includes("♣") || suitStr === "C") denom = "clubs";
  else if (suitStr.includes("♦") || suitStr === "D") denom = "diamonds";
  else if (suitStr.includes("♥") || suitStr === "H") denom = "hearts";
  else if (suitStr.includes("♠") || suitStr === "S") denom = "spades";
  else denom = "no-trump";

  return { level, denomination: denom };
}

function formatCardLabel(card: { rank: string; suit: string }): string {
  return `${card.rank} of ${card.suit}`;
}

function formatContractSummary(contract: BridgeRulesState["contract"] | null) {
  if (!contract) return "Bidding ended.";
  const denom = contract.trumpSuit === "no-trump" ? "NT" : contract.trumpSuit;
  const dbl = contract.redoubled
    ? " redoubled"
    : contract.doubled
      ? " doubled"
      : "";
  return `Bidding ended: ${contract.level} ${denom}${dbl} by ${contract.declarer}.`;
}

function formatTrickSummary(
  trickNumber: number,
  trickCards: Array<{ player: string; rank: string; suit: string }>,
  winner: string
): string {
  const plays = trickCards
    .map((card) => `${card.player} ${formatCardLabel(card)}`)
    .join(", ");
  return `Trick ${trickNumber}: ${plays}; winner ${winner}.`;
}

function isHigherBid(
  next: { level: number; denom: Denomination },
  current: BridgeBid | null
): boolean {
  if (!current) return true;
  if (next.level !== current.level) {
    return next.level > current.level;
  }
  return (
    BID_DENOMS.indexOf(next.denom) > BID_DENOMS.indexOf(current.denomination)
  );
}

function getBridgeRulesState(raw: unknown): BridgeRulesState {
  const base: BridgeRulesState = {
    hasDealt: false,
    dealNumber: 0,
    dealerSeat: "N",
    phase: "bidding",
    bidding: { history: [], highestBid: null, passesInRow: 0 },
    contract: null,
    play: null,
    currentTrick: { cards: [], leadSuit: null },
    currentTrickNumber: 1,
    tricksNS: 0,
    tricksEW: 0,
    aboveNS: 0,
    belowNS: 0,
    aboveEW: 0,
    belowEW: 0,
    gamesNS: 0,
    gamesEW: 0,
    rubberFinished: false,
    result: null,
    recap: [],
  };

  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Partial<BridgeRulesState>;
  return {
    ...base,
    ...obj,
    recap: obj.recap ?? base.recap,
    bidding: { ...base.bidding, ...(obj.bidding ?? {}) },
    currentTrick: { ...base.currentTrick, ...(obj.currentTrick ?? {}) },
  };
}

function deriveActions(
  rulesState: BridgeRulesState,
  currentPlayer: string | null
): ActionGrid {
  if (!currentPlayer || rulesState.rubberFinished)
    return { rows: 0, cols: 0, cells: [] };
  if (rulesState.phase === "play") return { rows: 0, cols: 0, cells: [] };

  const cells: ActionCell[] = [];
  let row = 0;
  let col = 0;
  const highest = rulesState.bidding.highestBid;

  for (const level of BID_LEVELS) {
    for (const denom of BID_DENOMS) {
      const label = formatBid(level, denom);
      const suffix = denom === "no-trump" ? "NT" : denom[0].toUpperCase();
      const id = `${level}${suffix}`;
      cells.push({
        id,
        label,
        enabled: isHigherBid({ level, denom }, highest),
        row,
        col,
      });
      col++;
      if (col >= 5) {
        col = 0;
        row++;
      }
    }
  }

  const canDouble =
    !!highest &&
    partnership(highest.bidder) !== partnership(currentPlayer) &&
    !!highest.doubled === false &&
    !!highest.redoubled === false;
  const canRedouble =
    !!highest &&
    partnership(highest.bidder) === partnership(currentPlayer) &&
    !!highest.doubled === true &&
    !!highest.redoubled === false;

  cells.push({
    id: "pass",
    label: "Pass",
    enabled: true,
    row,
    col: 0,
    colspan: 1,
  });
  cells.push({
    id: "double",
    label: "Double",
    enabled: canDouble,
    row,
    col: 1,
    colspan: 2,
  });
  cells.push({
    id: "redouble",
    label: "Redouble",
    enabled: canRedouble,
    row,
    col: 3,
    colspan: 2,
  });

  return { rows: row + 1, cols: 5, cells };
}

function deriveScoreboards(rulesState: BridgeRulesState): Scoreboard[] {
  const {
    aboveNS,
    belowNS,
    aboveEW,
    belowEW,
    gamesNS,
    gamesEW,
    contract,
    phase,
    bidding,
    tricksNS,
    tricksEW,
  } = rulesState;

  const highestBid = bidding.highestBid;
  const highestBidLabel = highestBid
    ? `${formatBid(highestBid.level, highestBid.denomination)}${highestBid.redoubled ? "××" : highestBid.doubled ? "×" : ""} (${highestBid.bidder})`
    : "—";

  const contractLabel = contract
    ? `${contract.level}${formatBid(0, contract.trumpSuit).slice(1)}${contract.redoubled ? "××" : contract.doubled ? "×" : ""} (${contract.declarer})`
    : "—";

  return [
    {
      id: "bridge-main",
      title: "Rubber Bridge – Score Sheet",
      rows: 7,
      cols: 3,
      cells: [
        { row: 0, col: 0, text: "Category", role: "header" },
        { row: 0, col: 1, text: "WE (NS)", role: "header" },
        { row: 0, col: 2, text: "THEY (EW)", role: "header" },
        { row: 1, col: 0, text: "Above Line (Bonuses)", role: "header" },
        { row: 1, col: 1, text: String(aboveNS) },
        { row: 1, col: 2, text: String(aboveEW) },
        { row: 2, col: 0, text: "Below Line (Contract)", role: "header" },
        { row: 2, col: 1, text: String(belowNS) },
        { row: 2, col: 2, text: String(belowEW) },
        { row: 3, col: 0, text: "Games Won", role: "header" },
        { row: 3, col: 1, text: String(gamesNS) },
        { row: 3, col: 2, text: String(gamesEW) },
        { row: 4, col: 0, text: "Current Deal", role: "header" },
        { row: 4, col: 1, text: `Tricks: ${tricksNS}`, align: "center" },
        { row: 4, col: 2, text: `Tricks: ${tricksEW}`, align: "center" },
        { row: 5, col: 0, text: "Phase / Contract", role: "header" },
        { row: 5, col: 1, text: phase.toUpperCase(), align: "center" },
        { row: 5, col: 2, text: contractLabel, align: "center" },
        { row: 6, col: 0, text: "Current Bid", role: "header" },
        { row: 6, col: 1, text: highestBidLabel, colspan: 2, align: "center" },
      ],
    },
  ];
}

function resolveTrickWinner(
  cards: Array<{ cardId: number; player: string; suit: string; rank: string }>,
  leadSuit: string | null,
  trumpSuit: Denomination | null
): string {
  let winner = cards[0]?.player ?? "";
  let bestScore = -1;
  for (const card of cards) {
    const rIdx = RANK_ORDER.indexOf(card.rank as (typeof RANK_ORDER)[number]);
    let score = rIdx >= 0 ? rIdx : -1;
    if (trumpSuit && trumpSuit !== "no-trump" && card.suit === trumpSuit)
      score += 200;
    else if (leadSuit && card.suit !== leadSuit) score = -1;
    if (score > bestScore) {
      bestScore = score;
      winner = card.player;
    }
  }
  return winner;
}

function calculateDealScore(nextState: BridgeRulesState): string {
  const c = nextState.contract;
  if (!c) return "Passed out.";

  const side = c.declarerSide;
  const isVulnerable =
    (side === "NS" ? nextState.gamesNS : nextState.gamesEW) > 0;
  const tricksMade = side === "NS" ? nextState.tricksNS : nextState.tricksEW;
  const diff = tricksMade - c.targetTricks;
  const multiplier = c.redoubled ? 4 : c.doubled ? 2 : 1;

  if (diff >= 0) {
    // Contract Made
    let trickPoints = 0;
    if (c.trumpSuit === "clubs" || c.trumpSuit === "diamonds")
      trickPoints = 20 * c.level;
    else if (c.trumpSuit === "hearts" || c.trumpSuit === "spades")
      trickPoints = 30 * c.level;
    else trickPoints = 40 + 30 * (c.level - 1);

    trickPoints *= multiplier;

    if (side === "NS") nextState.belowNS += trickPoints;
    else nextState.belowEW += trickPoints;

    // Overtricks
    if (diff > 0) {
      let overtrickPoints = 0;
      if (c.redoubled) overtrickPoints = diff * (isVulnerable ? 400 : 200);
      else if (c.doubled) overtrickPoints = diff * (isVulnerable ? 200 : 100);
      else {
        if (c.trumpSuit === "clubs" || c.trumpSuit === "diamonds")
          overtrickPoints = diff * 20;
        else overtrickPoints = diff * 30;
      }
      if (side === "NS") nextState.aboveNS += overtrickPoints;
      else nextState.aboveEW += overtrickPoints;
    }

    // Slam bonuses (only if bid and made)
    if (tricksMade >= 12 && c.level === 6) {
      if (side === "NS") nextState.aboveNS += isVulnerable ? 750 : 500;
      else nextState.aboveEW += isVulnerable ? 750 : 500;
    } else if (tricksMade === 13 && c.level === 7) {
      if (side === "NS") nextState.aboveNS += isVulnerable ? 1500 : 1000;
      else nextState.aboveEW += isVulnerable ? 1500 : 1000;
    }

    // Doubled/Redoubled "Insult" bonus
    if (c.redoubled) {
      if (side === "NS") nextState.aboveNS += 100;
      else nextState.aboveEW += 100;
    } else if (c.doubled) {
      if (side === "NS") nextState.aboveNS += 50;
      else nextState.aboveEW += 50;
    }

    // Game check
    if (nextState.belowNS >= 100) {
      nextState.gamesNS++;
      nextState.belowNS = 0;
      nextState.belowEW = 0;
    } else if (nextState.belowEW >= 100) {
      nextState.gamesEW++;
      nextState.belowNS = 0;
      nextState.belowEW = 0;
    }
  } else {
    // Contract Failed (Undertricks)
    const down = Math.abs(diff);
    let penalty = 0;
    if (c.redoubled) {
      if (!isVulnerable) {
        penalty = 200;
        if (down > 1) penalty += Math.min(down - 1, 2) * 400;
        if (down > 3) penalty += (down - 3) * 600;
      } else {
        penalty = 400 + (down - 1) * 600;
      }
    } else if (c.doubled) {
      if (!isVulnerable) {
        penalty = 100;
        if (down > 1) penalty += Math.min(down - 1, 2) * 200;
        if (down > 3) penalty += (down - 3) * 300;
      } else {
        penalty = 200 + (down - 1) * 300;
      }
    } else {
      penalty = down * (isVulnerable ? 100 : 50);
    }
    if (side === "NS") nextState.aboveEW += penalty;
    else nextState.aboveNS += penalty;
  }

  // Rubber completion
  if (nextState.gamesNS === 2 || nextState.gamesEW === 2) {
    nextState.rubberFinished = true;
    if (nextState.gamesNS === 2) {
      nextState.aboveNS += nextState.gamesEW === 0 ? 700 : 500;
    } else {
      nextState.aboveEW += nextState.gamesNS === 0 ? 700 : 500;
    }
    nextState.result =
      nextState.gamesNS === 2 ? "NS wins Rubber" : "EW wins Rubber";
  }

  const resultText =
    diff >= 0 ? `Made (${diff} over)` : `Down ${Math.abs(diff)}`;
  return `Hand ${nextState.dealNumber} Result: ${c.declarer} bid ${formatBid(
    c.level,
    c.trumpSuit
  )}${c.redoubled ? " redoubled" : c.doubled ? " doubled" : ""}, made ${tricksMade} tricks (${resultText}).`;
}

function resetForNextDeal(
  state: ValidationState,
  rulesState: BridgeRulesState,
  projectedPiles?: ProjectedPiles,
  options?: { summary?: string }
) {
  const events: EngineEvent[] = gatherAllCards(state, {
    projectedPiles,
  });

  // Reset all hand visibilities to owner-only for the next deal
  const seats: BridgeSeat[] = ["N", "E", "S", "W"];
  for (const seat of seats) {
    events.push({
      type: "set-pile-visibility",
      pileId: `${seat}-hand`,
      visibility: "owner",
    });
  }

  const nextDealer = NEXT_PLAYER[rulesState.dealerSeat];
  const nextDealNumber = rulesState.dealNumber + 1;

  // Build next recap: optionally collapse previous entries with summary
  const nextRecap = options?.summary
    ? [
        options.summary,
        `Hand ${nextDealNumber} started (dealer ${nextDealer}).`,
      ]
    : [
        ...rulesState.recap,
        `Hand ${nextDealNumber} started (dealer ${nextDealer}).`,
      ];

  const nextRulesState: BridgeRulesState = {
    ...rulesState,
    hasDealt: false,
    phase: "bidding",
    dealNumber: nextDealNumber,
    dealerSeat: nextDealer,
    bidding: { history: [], highestBid: null, passesInRow: 0 },
    contract: null,
    play: null,
    currentTrick: { cards: [], leadSuit: null },
    currentTrickNumber: 1,
    tricksNS: 0,
    tricksEW: 0,
    result: null,
    recap: nextRecap,
  };
  events.push({ type: "set-rules-state", rulesState: nextRulesState });
  return { events, nextRulesState };
}

function handleBidding(
  state: ValidationState,
  intent: ClientIntent,
  rulesState: BridgeRulesState
): ValidationResult {
  if (intent.type !== "action")
    return {
      valid: false,
      reason: "Bidding requires an action intent.",
      engineEvents: [],
    };
  const actingPlayer = state.currentPlayer ?? intent.playerId;
  const available = deriveActions(rulesState, actingPlayer);
  const chosen = available.cells.find((c) => c.id === intent.action);
  if (!chosen || !chosen.enabled)
    return {
      valid: false,
      reason: "That action is not available right now.",
      engineEvents: [],
    };

  const history = [
    ...rulesState.bidding.history,
    { player: intent.playerId, call: intent.action },
  ];
  let highestBid = rulesState.bidding.highestBid;
  let passesInRow = rulesState.bidding.passesInRow;
  let phase = rulesState.phase;
  let contract = rulesState.contract;
  let play = rulesState.play;
  let historyEntry: string | null = null;
  const actingSeat = toBridgeSeat(intent.playerId);
  let nextPlayer: string | null = actingSeat ? NEXT_PLAYER[actingSeat] : null;

  if (intent.action === "pass") passesInRow++;
  else if (intent.action === "double") {
    highestBid = { ...highestBid!, doubled: true };
    passesInRow = 0;
  } else if (intent.action === "redouble") {
    highestBid = { ...highestBid!, redoubled: true };
    passesInRow = 0;
  } else {
    const p = parseBid(intent.action);
    if (!p)
      return {
        valid: false,
        reason: "The bid format is invalid.",
        engineEvents: [],
      };
    highestBid = {
      level: p.level,
      denomination: p.denomination,
      bidder: intent.playerId,
    };
    passesInRow = 0;
  }

  if (highestBid && passesInRow >= 3) {
    phase = "play";

    // Declarer is the first person in the partnership to bid the denomination
    const side = partnership(highestBid.bidder);
    const denom = highestBid.denomination;
    let declarer = highestBid.bidder;
    for (const h of history) {
      const p = parseBid(h.call);
      if (p && p.denomination === denom && partnership(h.player) === side) {
        declarer = h.player;
        break;
      }
    }

    contract = {
      level: highestBid.level,
      trumpSuit: highestBid.denomination,
      declarer,
      declarerSide: side ?? "NS",
      targetTricks: highestBid.level + 6,
      doubled: highestBid.doubled ?? false,
      redoubled: highestBid.redoubled ?? false,
    };
    const dummySeat = partnerSeat(declarer)!;
    const openingLeader = NEXT_PLAYER[toBridgeSeat(declarer)!];
    play = { dummySeat, turnSeat: openingLeader, dummyRevealed: false };
    nextPlayer = openingLeader;
    historyEntry = formatContractSummary(contract);
  } else if (!highestBid && passesInRow >= 4) {
    const { events: rEvents, nextRulesState: rState } = resetForNextDeal(
      state,
      rulesState,
      undefined,
      { summary: `Hand ${rulesState.dealNumber} Result: Passed out.` }
    );
    return {
      valid: true,
      engineEvents: [
        ...rEvents,
        {
          type: "announce",
          text: `Hand ${rulesState.dealNumber} Result: Passed out.`,
          anchor: { type: "screen" },
        },
        { type: "set-rules-state", rulesState: rState },
        { type: "set-current-player", player: rState.dealerSeat },
      ],
    };
  }

  const nextRulesState: BridgeRulesState = {
    ...rulesState,
    phase,
    bidding: { history, highestBid, passesInRow },
    contract,
    play,
  };
  if (historyEntry) {
    nextRulesState.recap = [...nextRulesState.recap, historyEntry];
  }
  return {
    valid: true,
    engineEvents: [
      ...(historyEntry
        ? [
            {
              type: "announce",
              text: historyEntry,
              anchor: { type: "screen" },
            } as const,
          ]
        : []),
      { type: "set-rules-state", rulesState: nextRulesState },
      {
        type: "set-actions",
        actions: deriveActions(nextRulesState, nextPlayer),
      },
      {
        type: "set-scoreboards",
        scoreboards: deriveScoreboards(nextRulesState),
      },
      { type: "set-current-player", player: nextPlayer },
    ],
  };
}

function handlePlay(
  state: ValidationState,
  intent: ClientIntent,
  rulesState: BridgeRulesState
): ValidationResult {
  if (intent.type !== "move")
    return {
      valid: false,
      reason: "Play requires a move intent.",
      engineEvents: [],
    };
  const play = rulesState.play!;
  const declarer = rulesState.contract!.declarer;
  const sourcePile = state.piles[intent.fromPileId];

  // Engine guarantees cardId is defined for move intents
  const cardId = intent.cardId!;
  // Engine guarantees card exists in source pile
  const movedCard = sourcePile.cards!.find((c) => c.id === cardId)!;
  const leadSuit = rulesState.currentTrick.leadSuit;

  if (intent.toPileId !== "trick") {
    return {
      valid: false,
      reason: "Cards must be played to the center trick pile.",
      engineEvents: [],
    };
  }

  if (intent.fromPileId !== `${play.turnSeat}-hand`) {
    const seatMap: Record<string, string> = {
      N: "North",
      E: "East",
      S: "South",
      W: "West",
    };
    const turnName = seatMap[play.turnSeat] || play.turnSeat;
    const isDummy = play.turnSeat === play.dummySeat;
    const reason = isDummy
      ? `It is the Dummy's turn (${turnName}). Please play a card from the Dummy's hand.`
      : `It is currently ${turnName}'s turn to play.`;
    return { valid: false, reason, engineEvents: [] };
  }

  if (
    decisionMakerForSeat(play.turnSeat, declarer, play.dummySeat) !==
    intent.playerId
  ) {
    return {
      valid: false,
      reason: "You are not authorized to play for this seat.",
      engineEvents: [],
    };
  }
  if (
    leadSuit &&
    movedCard!.suit !== leadSuit &&
    sourcePile.cards!.some((c) => c.suit === leadSuit)
  ) {
    return {
      valid: false,
      reason: `Must follow suit: ${getSuitSymbol(leadSuit)}`,
      engineEvents: [],
    };
  }

  const engineEvents: EngineEvent[] = [
    {
      type: "move-cards",
      fromPileId: intent.fromPileId,
      toPileId: "trick",
      cardIds: [intent.cardId!],
    },
  ];
  const trickCards = [
    ...rulesState.currentTrick.cards,
    {
      cardId: intent.cardId!,
      player: play.turnSeat,
      suit: movedCard!.suit,
      rank: movedCard!.rank,
    },
  ];
  const nextState: BridgeRulesState = {
    ...rulesState,
    currentTrick: { cards: trickCards, leadSuit: leadSuit ?? movedCard!.suit },
  };

  if (trickCards.length === 1 && !play.dummyRevealed) {
    engineEvents.push({
      type: "set-pile-visibility",
      pileId: `${play.dummySeat}-hand`,
      visibility: "public",
    });
    nextState.play = { ...play, dummyRevealed: true };
  }

  let nextPlayer: string | null = null;
  if (trickCards.length === 4) {
    const winner = resolveTrickWinner(
      trickCards,
      nextState.currentTrick.leadSuit,
      rulesState.contract!.trumpSuit
    );
    nextState.recap = [
      ...nextState.recap,
      formatTrickSummary(rulesState.currentTrickNumber, trickCards, winner),
    ];
    const side = partnership(winner)!;

    // Announce trick winner
    engineEvents.push({
      type: "announce",
      text: `Trick won by ${winner}`,
      anchor: { type: "pile", pileId: "trick" },
    });

    engineEvents.push({
      type: "move-cards",
      fromPileId: "trick",
      toPileId: `${side}-won`,
      cardIds: trickCards.map((c) => c.cardId) as [number, ...number[]],
    });
    nextState.tricksNS += side === "NS" ? 1 : 0;
    nextState.tricksEW += side === "EW" ? 1 : 0;
    nextState.currentTrick = { cards: [], leadSuit: null };
    nextState.currentTrickNumber++;
    nextState.trickLeader = winner;
    if (nextState.currentTrickNumber > 13) {
      const dealSummary = calculateDealScore(nextState);
      if (nextState.rubberFinished) {
        engineEvents.push({
          type: "set-winner",
          winner: nextState.gamesNS === 2 ? "NS" : "EW",
        });
        nextPlayer = null;
      } else {
        const projected = projectPilesAfterEvents(state, engineEvents, {
          includeCards: true,
        });
        const { events: rEvents, nextRulesState: rState } = resetForNextDeal(
          state,
          nextState,
          projected,
          { summary: dealSummary }
        );
        engineEvents.push(...rEvents);
        return {
          valid: true,
          engineEvents: [
            ...engineEvents,
            { type: "announce", text: dealSummary, anchor: { type: "screen" } },
            { type: "set-rules-state", rulesState: rState },
            {
              type: "set-actions",
              actions: deriveActions(rState, rState.dealerSeat),
            },
            { type: "set-scoreboards", scoreboards: deriveScoreboards(rState) },
            { type: "set-current-player", player: rState.dealerSeat },
          ],
        };
      }
    } else {
      nextPlayer = decisionMakerForSeat(winner, declarer, play.dummySeat);
      nextState.play = {
        ...(nextState.play ?? play),
        turnSeat: winner as BridgeSeat,
      };
    }
  } else {
    const nextSeat = NEXT_PLAYER[play.turnSeat as BridgeSeat];
    nextPlayer = decisionMakerForSeat(nextSeat, declarer, play.dummySeat);
    nextState.play = { ...(nextState.play ?? play), turnSeat: nextSeat };
  }

  return {
    valid: true,
    engineEvents: [
      ...engineEvents,
      { type: "set-rules-state", rulesState: nextState },
      { type: "set-actions", actions: deriveActions(nextState, nextPlayer) },
      { type: "set-scoreboards", scoreboards: deriveScoreboards(nextState) },
      { type: "set-current-player", player: nextPlayer },
    ],
  };
}

export const bridgeRules: GameRuleModule = {
  listLegalIntentsForPlayer(
    state: ValidationState,
    playerId: string
  ): ClientIntent[] {
    const intents: ClientIntent[] = [];
    if (
      state.winner ||
      (state.currentPlayer && state.currentPlayer !== playerId)
    )
      return intents;

    const rulesState = getBridgeRulesState(state.rulesState);
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

    if (rulesState.phase === "bidding") {
      const actions = deriveActions(rulesState, playerId);
      for (const c of actions.cells) {
        const candidate: ClientIntent = {
          type: "action",
          gameId,
          playerId,
          action: c.id,
        };
        if (this.validate(state, candidate).valid) {
          intents.push(candidate);
        }
      }
      return intents;
    }

    if (rulesState.phase === "play" && rulesState.play) {
      const play = rulesState.play;
      // In bridge, declarer plays for dummy. So we need to consider moves from multiple piles.
      const declarer = rulesState.contract?.declarer;
      const dummySeat = play.dummySeat;
      const turnSeat = play.turnSeat;

      // Only the person responsible for the turn seat can play
      const manager = decisionMakerForSeat(turnSeat, declarer!, dummySeat);
      if (manager !== playerId) return [];

      // Candidate: any card from the hand that's supposed to play
      const hand = state.piles[`${turnSeat}-hand`]?.cards ?? [];
      for (const c of hand) {
        const candidate: ClientIntent = {
          type: "move",
          gameId,
          playerId,
          fromPileId: `${turnSeat}-hand`,
          toPileId: "trick",
          cardId: c.id,
        };
        if (this.validate(state, candidate).valid) {
          intents.push(candidate);
        }
      }
    }
    return intents;
  },

  validate(state: ValidationState, intent: ClientIntent): ValidationResult {
    const rulesState = getBridgeRulesState(state.rulesState);
    if (!rulesState.hasDealt) {
      if (intent.type === "action" && intent.action === "start-game") {
        const events: EngineEvent[] = gatherAllCards(state);

        const nextDealNumber =
          rulesState.dealNumber === 0 ? 1 : rulesState.dealNumber;

        const shuffledCardIds = shuffleAllCards(
          state,
          nextDealNumber,
          "BRIDGE"
        );

        const order = ["N-hand", "E-hand", "S-hand", "W-hand"] as const;
        const { events: dealEvents } = distributeRoundRobin(
          shuffledCardIds,
          order,
          13
        );
        events.push(...dealEvents);

        const nextRS: BridgeRulesState = {
          ...rulesState,
          hasDealt: true,
          dealNumber: nextDealNumber,
        };
        nextRS.recap = [
          ...nextRS.recap,
          `Hand ${nextDealNumber} started (dealer ${nextRS.dealerSeat}).`,
        ];
        events.push({ type: "set-rules-state", rulesState: nextRS });
        return {
          valid: true,
          engineEvents: [
            ...events,
            { type: "set-current-player", player: nextRS.dealerSeat },
            {
              type: "set-actions",
              actions: deriveActions(nextRS, nextRS.dealerSeat),
            },
            { type: "set-scoreboards", scoreboards: deriveScoreboards(nextRS) },
          ],
        };
      }
      return {
        valid: false,
        reason: "The game has not started yet. Click 'Start Game' to begin.",
        engineEvents: [],
      };
    }
    return rulesState.phase === "bidding"
      ? handleBidding(state, intent, rulesState)
      : handlePlay(state, intent, rulesState);
  },
};

export const bridgePlugin: GamePlugin = {
  id: "bridge",
  gameName: META.gameName,
  ruleModule: bridgeRules,
  description: META.description,
  validationHints: {
    sharedPileIds: ["trick", "deck", "NS-won", "EW-won"],
    isPileAlwaysVisibleToRules: (pid) => pid.endsWith("-hand"),
    buildPlayedByLookup: (s: GameState) => {
      const l = new Map<number, string | null>();
      const rs = (s.rulesState as BridgeRulesState | null) ?? null;
      const cards = rs?.currentTrick?.cards;
      if (Array.isArray(cards))
        cards.forEach((c) => l.set(c.cardId, c.player ?? null));
      return l;
    },
  },
  aiSupport: {
    buildContext: (view: AiView): AiContext => {
      // Extract recap from rulesState
      const rulesState = (view.public as { rulesState?: unknown })
        .rulesState as BridgeRulesState | undefined;

      if (!rulesState || !Array.isArray(rulesState.recap)) {
        return {};
      }

      // Build facts from phase and game state
      const facts: Record<string, unknown> = {
        phase: rulesState.phase,
        dealNumber: rulesState.dealNumber,
      };

      if (rulesState.phase === "bidding") {
        facts.passesInRow = rulesState.bidding.passesInRow;
        facts.highestBid = rulesState.bidding.highestBid
          ? `${rulesState.bidding.highestBid.level}${rulesState.bidding.highestBid.denomination}`
          : null;
      } else if (rulesState.phase === "play" && rulesState.contract) {
        facts.contract = `${rulesState.contract.level}${rulesState.contract.trumpSuit}`;
        facts.declarer = rulesState.contract.declarer;
        facts.trumpSuit = rulesState.contract.trumpSuit;
        facts.currentTrickNumber = rulesState.currentTrickNumber;
        facts.tricksNS = rulesState.tricksNS;
        facts.tricksEW = rulesState.tricksEW;
        if (rulesState.play) {
          facts.dummySeat = rulesState.play.dummySeat;
          facts.playSeat = rulesState.play.turnSeat;
          facts.dummyRevealed = rulesState.play.dummyRevealed;
          facts.playingDummy =
            rulesState.play.dummyRevealed &&
            rulesState.play.turnSeat !== view.seat;
        }
        if (rulesState.currentTrick.leadSuit) {
          facts.leadSuit = rulesState.currentTrick.leadSuit;
        }
      }

      return {
        recap: rulesState.recap.length > 0 ? rulesState.recap : undefined,
        facts,
      };
    },
  },
};
