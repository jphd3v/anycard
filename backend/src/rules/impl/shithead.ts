import type { GamePlugin, GameRuleModule } from "../interface.js";
import type { ValidationState } from "../../validation-state.js";
import type { ClientIntent, Scoreboard } from "../../../../shared/schemas.js";
import type {
  EngineEvent,
  ValidationResult,
} from "../../../../shared/validation.js";
import type { ProjectedPiles } from "../util/piles.js";
import type { AiView, AiContext } from "../../../../shared/src/ai/types.js";
import { loadGameMeta } from "../meta.js";
import { projectPilesAfterEvents } from "../util/piles.js";
import { createRandom, stringToSeed } from "../../util/random.js";

const META = loadGameMeta("shithead");

type Phase = "deal" | "setup" | "play" | "game-over";

interface ShitheadRulesState {
  players: string[];
  hasDealt: boolean;
  dealNumber: number;
  phase: Phase;
  dealerIndex: number;
  firstPlayerId: string | null;
  ready: Record<string, boolean>;
  recap: string[];
  turnRankPlayed: string | null; // Rank played this turn (null if no move made yet)
}

const RANK_ORDER = [
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
  "2",
];

const RANK_VALUE: Record<string, number> = {
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
  "2": 15,
};

function getPlayers(state: ValidationState): string[] {
  if (state.players && state.players.length > 0) {
    return state.players.map((p) => p.id);
  }
  return ["P1", "P2", "P3"];
}

function normalizeReady(
  value: unknown,
  players: string[],
  fallback: Record<string, boolean>
): Record<string, boolean> {
  const next = { ...fallback };
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const playerId of players) {
      const entry = record[playerId];
      if (typeof entry === "boolean") next[playerId] = entry;
    }
  }
  return next;
}

function getRulesState(obj: unknown, players: string[]): ShitheadRulesState {
  const base: ShitheadRulesState = {
    players,
    hasDealt: false,
    dealNumber: 0,
    phase: "deal",
    dealerIndex: 0,
    firstPlayerId: null,
    ready: Object.fromEntries(players.map((p) => [p, false])),
    recap: [],
    turnRankPlayed: null,
  };

  if (!obj || typeof obj !== "object") return base;
  const o = obj as Record<string, unknown>;
  const playersFromState = Array.isArray(o.players)
    ? (o.players.filter((p) => typeof p === "string") as string[])
    : base.players;
  const resolvedPlayers =
    playersFromState.length > 0 ? playersFromState : players;

  return {
    players: resolvedPlayers,
    hasDealt: typeof o.hasDealt === "boolean" ? o.hasDealt : base.hasDealt,
    dealNumber:
      typeof o.dealNumber === "number" ? o.dealNumber : base.dealNumber,
    phase:
      o.phase === "deal" ||
      o.phase === "setup" ||
      o.phase === "play" ||
      o.phase === "game-over"
        ? (o.phase as Phase)
        : base.phase,
    dealerIndex:
      typeof o.dealerIndex === "number" ? o.dealerIndex : base.dealerIndex,
    firstPlayerId:
      typeof o.firstPlayerId === "string"
        ? o.firstPlayerId
        : base.firstPlayerId,
    ready: normalizeReady(o.ready, resolvedPlayers, base.ready),
    recap: Array.isArray(o.recap) ? o.recap : base.recap,
    turnRankPlayed:
      typeof o.turnRankPlayed === "string" || o.turnRankPlayed === null
        ? (o.turnRankPlayed as string | null)
        : base.turnRankPlayed,
  };
}

function rotatePlayers(players: string[], startIndex: number): string[] {
  if (players.length === 0) return [];
  const idx = ((startIndex % players.length) + players.length) % players.length;
  return [...players.slice(idx), ...players.slice(0, idx)];
}

function getSetupOrder(
  rulesState: ShitheadRulesState,
  players: string[]
): string[] {
  return rotatePlayers(players, rulesState.dealerIndex + 1);
}

function getNextUnreadyPlayer(
  order: string[],
  ready: Record<string, boolean>,
  current: string
): string | null {
  if (order.length === 0) return null;
  const index = order.indexOf(current);
  if (index === -1) {
    return order.find((p) => !ready[p]) ?? null;
  }
  for (let i = 1; i <= order.length; i++) {
    const candidate = order[(index + i) % order.length];
    if (!ready[candidate]) return candidate;
  }
  return null;
}

function getPileSize(piles: ProjectedPiles, pileId: string): number {
  return piles[pileId]?.size ?? 0;
}

function totalPlayerCards(piles: ProjectedPiles, playerId: string): number {
  return (
    getPileSize(piles, `${playerId}-hand`) +
    getPileSize(piles, `${playerId}-up`) +
    getPileSize(piles, `${playerId}-down`)
  );
}

function getNextActivePlayer(
  current: string,
  players: string[],
  piles: ProjectedPiles
): string {
  const index = players.indexOf(current);
  if (index === -1) return players[0];
  for (let i = 1; i <= players.length; i++) {
    const candidate = players[(index + i) % players.length];
    if (totalPlayerCards(piles, candidate) > 0) return candidate;
  }
  return current;
}

function getRankValue(rank: string): number {
  return RANK_VALUE[rank] ?? 0;
}

function getTopDiscardRank(state: ValidationState): string | null {
  const discard = state.piles["discard"];
  const topCard =
    discard?.cards?.[discard.cards.length - 1] ?? discard?.topCard;
  return topCard?.rank ?? null;
}

function isPlayable(playedRank: string, topRank: string | null): boolean {
  if (!topRank) return true;
  if (playedRank === "2" || playedRank === "10") return true;
  if (topRank === "2") return true;
  return getRankValue(playedRank) >= getRankValue(topRank);
}

function extractCardIds(intent: ClientIntent): number[] {
  if (intent.type !== "move") return [];
  if (intent.cardId !== undefined) return [intent.cardId];
  return intent.cardIds ?? [];
}

function ensureCardsInPile(
  state: ValidationState,
  pileId: string,
  cardIds: number[]
): string | null {
  const pile = state.piles[pileId];
  const pileCards = pile?.cards ?? [];
  if (!pile || pileCards.length === 0) return "Pile is empty or not visible.";
  const available = new Set(pileCards.map((c) => c.id));
  for (const cardId of cardIds) {
    if (!available.has(cardId)) {
      return "Selected card is not in that pile.";
    }
  }
  return null;
}

function allSameRank(state: ValidationState, cardIds: number[]): string | null {
  if (cardIds.length === 0) return null;
  const first = state.allCards[cardIds[0]]?.rank ?? null;
  if (!first) return null;
  for (const id of cardIds) {
    const rank = state.allCards[id]?.rank ?? null;
    if (rank !== first) return null;
  }
  return first;
}

function groupCardsByRank(
  cards: Array<{ id: number; rank: string }>
): Map<string, number[]> {
  const byRank = new Map<string, number[]>();
  for (const card of cards) {
    const list = byRank.get(card.rank) ?? [];
    list.push(card.id);
    byRank.set(card.rank, list);
  }
  return byRank;
}

function formatCardRank(rank: string, count: number = 1): string {
  if (count === 1) return rank;
  return `${count}x${rank}`;
}

function deriveActions(
  rulesState: ShitheadRulesState,
  currentPlayerId: string | null,
  projected: ProjectedPiles
) {
  if (rulesState.phase === "setup") {
    return {
      rows: 1,
      cols: 1,
      cells: [{ id: "ready", label: "Ready", row: 0, col: 0, enabled: true }],
    };
  }

  if (rulesState.phase !== "play") return { rows: 0, cols: 0, cells: [] };
  if (!currentPlayerId) return { rows: 0, cols: 0, cells: [] };

  const handSize = getPileSize(projected, `${currentPlayerId}-hand`);
  const upSize = getPileSize(projected, `${currentPlayerId}-up`);
  const downSize = getPileSize(projected, `${currentPlayerId}-down`);
  const discardSize = getPileSize(projected, "discard");

  if (rulesState.turnRankPlayed) {
    return {
      rows: 1,
      cols: 1,
      cells: [
        {
          id: "end-turn",
          label: "End turn",
          row: 0,
          col: 0,
          enabled: true,
        },
      ],
    };
  }

  if (handSize > 0) {
    return {
      rows: 1,
      cols: 1,
      cells: [
        {
          id: "pick-up",
          label: "Pick up pile",
          row: 0,
          col: 0,
          enabled: discardSize > 0,
        },
      ],
    };
  }

  if (handSize === 0 && upSize === 0 && downSize > 0) {
    return {
      rows: 1,
      cols: 1,
      cells: [
        {
          id: "flip-down",
          label: "Flip facedown",
          row: 0,
          col: 0,
          enabled: true,
        },
      ],
    };
  }

  return { rows: 0, cols: 0, cells: [] };
}

function buildScoreboards(
  projected: ProjectedPiles,
  players: string[]
): Scoreboard[] {
  const rows = players.length + 2;
  const cells: Scoreboard["cells"] = [
    { row: 0, col: 0, text: "Player", role: "header" },
    { row: 0, col: 1, text: "Cards", role: "header" },
    { row: 0, col: 2, text: "Stage", role: "header" },
  ];

  players.forEach((playerId, idx) => {
    const handSize = getPileSize(projected, `${playerId}-hand`);
    const upSize = getPileSize(projected, `${playerId}-up`);
    const downSize = getPileSize(projected, `${playerId}-down`);
    const total = handSize + upSize + downSize;
    const stage =
      total === 0
        ? "Out"
        : handSize > 0
          ? "Hand"
          : upSize > 0
            ? "Face Up"
            : "Face Down";

    cells.push(
      { row: idx + 1, col: 0, text: playerId, role: "body" },
      { row: idx + 1, col: 1, text: String(total), role: "body" },
      { row: idx + 1, col: 2, text: stage, role: "body" }
    );
  });

  const stockSize = getPileSize(projected, "deck");
  cells.push(
    { row: rows - 1, col: 0, text: "Stock", role: "body" },
    { row: rows - 1, col: 1, text: String(stockSize), role: "body" },
    { row: rows - 1, col: 2, text: "", role: "body" }
  );

  return [
    {
      id: "shithead-status",
      title: "Status",
      rows,
      cols: 3,
      cells,
    },
  ];
}

function drawUpToThree(
  playerId: string,
  projected: ProjectedPiles
): EngineEvent[] {
  const handSize = getPileSize(projected, `${playerId}-hand`);
  const deckIds = projected["deck"]?.cardIds
    ? [...(projected["deck"].cardIds ?? [])]
    : [];
  const needed = Math.max(0, 3 - handSize);
  const events: EngineEvent[] = [];

  for (let i = 0; i < needed && deckIds.length > 0; i++) {
    const cardId = deckIds.pop();
    if (!cardId) break;
    events.push({
      type: "move-cards",
      fromPileId: "deck",
      toPileId: `${playerId}-hand`,
      cardIds: [cardId],
    });
  }

  return events;
}

function shouldClearDiscard(
  discardCards: Array<{ rank: string }>,
  playedRank: string
): boolean {
  if (playedRank === "10") return true;
  if (discardCards.length < 4) return false;
  const lastRank = discardCards[discardCards.length - 1]?.rank;
  if (!lastRank) return false;
  return discardCards.slice(-4).every((card) => card.rank === lastRank);
}

function resolveAfterPlay(
  state: ValidationState,
  rulesState: ShitheadRulesState,
  players: string[],
  playerId: string,
  playedRank: string,
  cardCount: number,
  engineEvents: EngineEvent[]
): ValidationResult {
  let projected = projectPilesAfterEvents(state, engineEvents);

  const discardCards = projected["discard"]?.cards ?? [];
  const shouldClear = shouldClearDiscard(discardCards, playedRank);

  // Build recap message for this play
  let recapMsg = `${playerId}: played ${formatCardRank(playedRank, cardCount)}`;

  if (shouldClear && projected["discard"]?.cardIds?.length) {
    if (playedRank === "10") {
      recapMsg += " (10 clears pile)";
    } else {
      recapMsg += " (4-of-a-kind clears pile)";
    }
    engineEvents.push({
      type: "move-cards",
      fromPileId: "discard",
      toPileId: "burned",
      cardIds: projected["discard"].cardIds as [number, ...number[]],
    });
    projected = projectPilesAfterEvents(state, engineEvents);
  }

  // Update recap
  rulesState.recap.push(recapMsg);

  // Check game over before modifying state further
  let projectedForChecks = projectPilesAfterEvents(state, engineEvents);
  const activePlayers = players.filter(
    (p) => totalPlayerCards(projectedForChecks, p) > 0
  );

  if (activePlayers.length <= 1) {
    const loser = activePlayers[0] ?? null;
    if (loser) {
      engineEvents.push({ type: "set-winner", winner: loser });
    }
    const nextRulesState = { ...rulesState, phase: "game-over" };
    engineEvents.push({
      type: "set-rules-state",
      rulesState: nextRulesState,
    });
    engineEvents.push({ type: "set-current-player", player: null });
    engineEvents.push({
      type: "set-actions",
      actions: { rows: 0, cols: 0, cells: [] },
    });
    engineEvents.push({
      type: "set-scoreboards",
      scoreboards: buildScoreboards(projectedForChecks, players),
    });
    return { valid: true, engineEvents };
  }

  const currentHasCards = totalPlayerCards(projectedForChecks, playerId) > 0;

  // Check if player can continue playing more cards of the same rank
  // IMPORTANT: Check BEFORE drawing cards
  const handPile = `${playerId}-hand`;
  const upPile = `${playerId}-up`;
  const handCards = projectedForChecks[handPile]?.cards ?? [];
  const upCards = projectedForChecks[upPile]?.cards ?? [];
  const availableCards = handCards.length > 0 ? handCards : upCards;

  const hasMoreOfSameRank = availableCards.some((c) => c.rank === playedRank);

  // Determine next player and turn state
  let nextPlayer: string;
  let shouldDrawCards = false;

  if (shouldClear && currentHasCards) {
    // Pile cleared (10 or 4-of-a-kind), same player continues with fresh turn
    nextPlayer = playerId;
    rulesState.turnRankPlayed = null;
    shouldDrawCards = true; // Draw when pile clears (new turn)
  } else if (hasMoreOfSameRank && currentHasCards) {
    // Player has more cards of the same rank, can continue turn
    nextPlayer = playerId;
    rulesState.turnRankPlayed = playedRank;
    shouldDrawCards = false; // DON'T draw mid-turn
  } else {
    // Turn ends, advance to next player
    nextPlayer = getNextActivePlayer(playerId, players, projected);
    rulesState.turnRankPlayed = null;
    shouldDrawCards = true; // Draw when turn ends
  }

  // Only draw cards when turn actually ends or pile clears
  if (shouldDrawCards) {
    const drawEvents = drawUpToThree(playerId, projectedForChecks);
    if (drawEvents.length > 0) {
      engineEvents.push(...drawEvents);
      projectedForChecks = projectPilesAfterEvents(state, engineEvents);
    }
  }

  engineEvents.push({ type: "set-rules-state", rulesState });
  engineEvents.push({ type: "set-current-player", player: nextPlayer });
  engineEvents.push({
    type: "set-actions",
    actions: deriveActions(rulesState, nextPlayer, projectedForChecks),
  });
  engineEvents.push({
    type: "set-scoreboards",
    scoreboards: buildScoreboards(projectedForChecks, players),
  });

  return { valid: true, engineEvents };
}

function pickDealerIndex(state: ValidationState, dealNumber: number): number {
  const baseSeed = stringToSeed(state.seed || "SHITHEAD");
  const random = createRandom(baseSeed + dealNumber);
  return Math.floor(random() * 3);
}

function findFirstPlayerFromDeal(
  state: ValidationState,
  dealOrder: string[],
  upCards: number[],
  handCards: number[]
): string {
  for (let i = 0; i < upCards.length; i++) {
    const cardId = upCards[i];
    const rank = state.allCards[cardId]?.rank;
    if (rank === "3") return dealOrder[i % dealOrder.length];
  }

  for (const rank of RANK_ORDER) {
    for (let i = 0; i < handCards.length; i++) {
      const cardId = handCards[i];
      const cardRank = state.allCards[cardId]?.rank;
      if (cardRank === rank) return dealOrder[i % dealOrder.length];
    }
  }

  return dealOrder[0];
}

export const shitheadRules: GameRuleModule = {
  validate(state: ValidationState, intent: ClientIntent): ValidationResult {
    const players = getPlayers(state);
    const rulesState = getRulesState(state.rulesState, players);

    if (players.length !== 3) {
      return {
        valid: false,
        reason: "Shithead is configured for exactly 3 players.",
        engineEvents: [],
      };
    }

    if (state.winner || rulesState.phase === "game-over") {
      return {
        valid: false,
        reason: "Game is already over.",
        engineEvents: [],
      };
    }

    if (!rulesState.hasDealt) {
      if (intent.type !== "action" || intent.action !== "start-game") {
        return {
          valid: false,
          reason: "Game has not started. Use the Start Game action.",
          engineEvents: [],
        };
      }

      const deckCards = state.piles["deck"]?.cards ?? [];
      if (deckCards.length !== 52) {
        return {
          valid: false,
          reason: "System Error: Deck must contain 52 cards.",
          engineEvents: [],
        };
      }

      const nextDealNumber = rulesState.dealNumber + 1;
      const dealerIndex = pickDealerIndex(state, nextDealNumber);
      const dealOrder = rotatePlayers(players, dealerIndex + 1);

      const deckIds = deckCards.map((c) => c.id);
      const takeTop = () => deckIds.pop();

      const engineEvents: EngineEvent[] = [];
      const upDealCards: number[] = [];
      const handDealCards: number[] = [];

      for (let i = 0; i < 3; i++) {
        for (const playerId of dealOrder) {
          const cardId = takeTop();
          if (!cardId) {
            return {
              valid: false,
              reason: "Not enough cards to deal.",
              engineEvents: [],
            };
          }
          engineEvents.push({
            type: "move-cards",
            fromPileId: "deck",
            toPileId: `${playerId}-down`,
            cardIds: [cardId],
          });
        }
      }

      for (let i = 0; i < 3; i++) {
        for (const playerId of dealOrder) {
          const cardId = takeTop();
          if (!cardId) {
            return {
              valid: false,
              reason: "Not enough cards to deal.",
              engineEvents: [],
            };
          }
          upDealCards.push(cardId);
          engineEvents.push({
            type: "move-cards",
            fromPileId: "deck",
            toPileId: `${playerId}-up`,
            cardIds: [cardId],
          });
        }
      }

      for (let i = 0; i < 3; i++) {
        for (const playerId of dealOrder) {
          const cardId = takeTop();
          if (!cardId) {
            return {
              valid: false,
              reason: "Not enough cards to deal.",
              engineEvents: [],
            };
          }
          handDealCards.push(cardId);
          engineEvents.push({
            type: "move-cards",
            fromPileId: "deck",
            toPileId: `${playerId}-hand`,
            cardIds: [cardId],
          });
        }
      }

      const firstPlayerId = findFirstPlayerFromDeal(
        state,
        dealOrder,
        upDealCards,
        handDealCards
      );
      const setupOrder = rotatePlayers(players, dealerIndex + 1);
      const setupStarter = setupOrder[0] ?? players[0];

      const nextRulesState: ShitheadRulesState = {
        ...rulesState,
        hasDealt: true,
        dealNumber: nextDealNumber,
        phase: "setup",
        dealerIndex,
        firstPlayerId,
        ready: Object.fromEntries(players.map((p) => [p, false])),
      };

      engineEvents.push({
        type: "set-rules-state",
        rulesState: nextRulesState,
      });
      engineEvents.push({
        type: "set-current-player",
        player: setupStarter,
      });
      engineEvents.push({
        type: "set-actions",
        actions: deriveActions(
          nextRulesState,
          setupStarter,
          projectPilesAfterEvents(state, engineEvents)
        ),
      });

      const projected = projectPilesAfterEvents(state, engineEvents);
      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: buildScoreboards(projected, players),
      });

      return { valid: true, engineEvents };
    }

    if (rulesState.phase === "setup") {
      if (intent.type === "action" && intent.action === "ready") {
        const playerId = intent.playerId;
        if (!players.includes(playerId)) {
          return {
            valid: false,
            reason: "Unknown player.",
            engineEvents: [],
          };
        }

        if (!state.currentPlayer || state.currentPlayer !== playerId) {
          return {
            valid: false,
            reason: "It is not your turn to confirm.",
            engineEvents: [],
          };
        }

        if (rulesState.ready[playerId]) {
          return {
            valid: false,
            reason: "You are already ready.",
            engineEvents: [],
          };
        }

        const projected = projectPilesAfterEvents(state, []);
        const handSize = getPileSize(projected, `${playerId}-hand`);
        const upSize = getPileSize(projected, `${playerId}-up`);
        if (handSize !== 3 || upSize !== 3) {
          return {
            valid: false,
            reason: "You must have exactly 3 hand cards and 3 face-up cards.",
            engineEvents: [],
          };
        }

        const nextReady = { ...rulesState.ready, [playerId]: true };
        const allReady = players.every((p) => nextReady[p]);
        const nextRulesState: ShitheadRulesState = {
          ...rulesState,
          ready: nextReady,
          phase: allReady ? "play" : "setup",
        };
        const setupOrder = getSetupOrder(nextRulesState, players);
        const nextPlayer = allReady
          ? (nextRulesState.firstPlayerId ?? setupOrder[0] ?? players[0])
          : getNextUnreadyPlayer(setupOrder, nextReady, playerId);

        const engineEvents: EngineEvent[] = [
          { type: "set-rules-state", rulesState: nextRulesState },
        ];
        if (!nextPlayer) {
          return {
            valid: false,
            reason: "No next player available.",
            engineEvents: [],
          };
        }
        engineEvents.push({ type: "set-current-player", player: nextPlayer });

        const projectedAfter = projectPilesAfterEvents(state, engineEvents);
        engineEvents.push({
          type: "set-actions",
          actions: deriveActions(nextRulesState, nextPlayer, projectedAfter),
        });
        engineEvents.push({
          type: "set-scoreboards",
          scoreboards: buildScoreboards(projectedAfter, players),
        });

        return { valid: true, engineEvents };
      }

      if (intent.type === "move") {
        const playerId = intent.playerId;
        if (!state.currentPlayer || state.currentPlayer !== playerId) {
          return {
            valid: false,
            reason: "It is not your turn to swap.",
            engineEvents: [],
          };
        }
        if (rulesState.ready[playerId]) {
          return {
            valid: false,
            reason: "You are already ready.",
            engineEvents: [],
          };
        }

        const from = intent.fromPileId;
        const to = intent.toPileId;
        const handPile = `${playerId}-hand`;
        const upPile = `${playerId}-up`;
        const isSwap =
          (from === handPile && to === upPile) ||
          (from === upPile && to === handPile);

        if (!isSwap) {
          return {
            valid: false,
            reason: "Only hand/face-up swaps are allowed during setup.",
            engineEvents: [],
          };
        }

        const cardIds = extractCardIds(intent);
        const pileError = ensureCardsInPile(state, from, cardIds);
        if (pileError) {
          return { valid: false, reason: pileError, engineEvents: [] };
        }

        const engineEvents: EngineEvent[] = [
          {
            type: "move-cards",
            fromPileId: from,
            toPileId: to,
            cardIds: cardIds as [number, ...number[]],
          },
        ];

        const projected = projectPilesAfterEvents(state, engineEvents);
        engineEvents.push({
          type: "set-actions",
          actions: deriveActions(rulesState, state.currentPlayer, projected),
        });
        engineEvents.push({
          type: "set-scoreboards",
          scoreboards: buildScoreboards(projected, players),
        });

        return { valid: true, engineEvents };
      }

      return {
        valid: false,
        reason: "Only swaps or Ready actions are allowed during setup.",
        engineEvents: [],
      };
    }

    if (rulesState.phase !== "play") {
      return {
        valid: false,
        reason: "Game is not in play phase.",
        engineEvents: [],
      };
    }

    if (!state.currentPlayer) {
      return {
        valid: false,
        reason: "No current player set.",
        engineEvents: [],
      };
    }

    if (intent.playerId !== state.currentPlayer) {
      return {
        valid: false,
        reason: "It is not your turn.",
        engineEvents: [],
      };
    }

    const playerId = intent.playerId;
    const handPile = `${playerId}-hand`;
    const upPile = `${playerId}-up`;
    const downPile = `${playerId}-down`;

    if (intent.type === "action") {
      if (intent.action === "pick-up") {
        if (rulesState.turnRankPlayed) {
          return {
            valid: false,
            reason: "You cannot pick up after playing a card this turn.",
            engineEvents: [],
          };
        }

        const handSize = state.piles[handPile]?.size ?? 0;
        if (handSize === 0) {
          return {
            valid: false,
            reason: "You can only pick up while playing from your hand.",
            engineEvents: [],
          };
        }

        const discardCards = state.piles["discard"]?.cards ?? [];
        if (discardCards.length === 0) {
          return {
            valid: false,
            reason: "Discard pile is empty.",
            engineEvents: [],
          };
        }

        const engineEvents: EngineEvent[] = [
          {
            type: "move-cards",
            fromPileId: "discard",
            toPileId: handPile,
            cardIds: discardCards.map((c) => c.id) as [number, ...number[]],
          },
        ];

        const projected = projectPilesAfterEvents(state, engineEvents);
        const nextPlayer = getNextActivePlayer(playerId, players, projected);

        // Add recap message and clear turn state
        rulesState.recap.push(
          `${playerId}: picked up pile (${discardCards.length} cards)`
        );
        rulesState.turnRankPlayed = null;
        engineEvents.push({ type: "set-rules-state", rulesState });

        engineEvents.push({ type: "set-current-player", player: nextPlayer });
        engineEvents.push({
          type: "set-actions",
          actions: deriveActions(rulesState, nextPlayer, projected),
        });
        engineEvents.push({
          type: "set-scoreboards",
          scoreboards: buildScoreboards(projected, players),
        });

        return { valid: true, engineEvents };
      }

      if (intent.action === "flip-down") {
        const handSize = state.piles[handPile]?.size ?? 0;
        const upSize = state.piles[upPile]?.size ?? 0;
        if (handSize > 0 || upSize > 0) {
          return {
            valid: false,
            reason: "You must finish your hand and face-up cards first.",
            engineEvents: [],
          };
        }

        const downCards = state.piles[downPile]?.cards ?? [];
        if (downCards.length === 0) {
          return {
            valid: false,
            reason: "No facedown cards remaining.",
            engineEvents: [],
          };
        }

        const flipped = downCards[downCards.length - 1];
        const playedRank = flipped.rank;
        const topRank = getTopDiscardRank(state);
        const canPlay = isPlayable(playedRank, topRank);

        const engineEvents: EngineEvent[] = [
          {
            type: "move-cards",
            fromPileId: downPile,
            toPileId: "discard",
            cardIds: [flipped.id],
          },
        ];

        if (!canPlay) {
          const projectedAfterPlay = projectPilesAfterEvents(
            state,
            engineEvents
          );
          const discardIds = projectedAfterPlay["discard"]?.cardIds ?? [];
          if (discardIds.length > 0) {
            engineEvents.push({
              type: "move-cards",
              fromPileId: "discard",
              toPileId: handPile,
              cardIds: discardIds as [number, ...number[]],
            });
          }

          const projected = projectPilesAfterEvents(state, engineEvents);
          const nextPlayer = getNextActivePlayer(playerId, players, projected);

          // Add recap message and clear turn state
          rulesState.recap.push(
            `${playerId}: flipped ${playedRank}, can't play, picks up pile (${discardIds.length} cards)`
          );
          rulesState.turnRankPlayed = null;
          engineEvents.push({ type: "set-rules-state", rulesState });

          engineEvents.push({ type: "set-current-player", player: nextPlayer });
          engineEvents.push({
            type: "set-actions",
            actions: deriveActions(rulesState, nextPlayer, projected),
          });
          engineEvents.push({
            type: "set-scoreboards",
            scoreboards: buildScoreboards(projected, players),
          });

          return { valid: true, engineEvents };
        }

        return resolveAfterPlay(
          state,
          rulesState,
          players,
          playerId,
          playedRank,
          1,
          engineEvents
        );
      }

      if (intent.action === "end-turn") {
        // Player explicitly ends their turn mid-turn
        if (!rulesState.turnRankPlayed) {
          return {
            valid: false,
            reason: "Cannot end turn before making a move.",
            engineEvents: [],
          };
        }

        const projectedBefore = projectPilesAfterEvents(state, []);
        const drawEvents = drawUpToThree(playerId, projectedBefore);
        const projectedAfter =
          drawEvents.length > 0
            ? projectPilesAfterEvents(state, drawEvents)
            : projectedBefore;

        // Clear turn state and advance to next player
        rulesState.turnRankPlayed = null;
        const nextPlayer = getNextActivePlayer(
          playerId,
          players,
          projectedBefore
        );

        const engineEvents: EngineEvent[] = [
          ...drawEvents,
          { type: "set-rules-state", rulesState },
          { type: "set-current-player", player: nextPlayer },
          {
            type: "set-actions",
            actions: deriveActions(rulesState, nextPlayer, projectedAfter),
          },
          {
            type: "set-scoreboards",
            scoreboards: buildScoreboards(projectedAfter, players),
          },
        ];

        return { valid: true, engineEvents };
      }

      return {
        valid: false,
        reason: "Unknown action.",
        engineEvents: [],
      };
    }

    if (intent.type !== "move") {
      return {
        valid: false,
        reason: "Only moves or actions are allowed.",
        engineEvents: [],
      };
    }

    const from = intent.fromPileId;
    const to = intent.toPileId;
    const cardIds = extractCardIds(intent);

    if (to !== "discard") {
      return {
        valid: false,
        reason: "Cards can only be played to the discard pile.",
        engineEvents: [],
      };
    }

    if (from !== handPile && from !== upPile) {
      return {
        valid: false,
        reason: "You can only play from your hand or face-up cards.",
        engineEvents: [],
      };
    }

    const pileError = ensureCardsInPile(state, from, cardIds);
    if (pileError) {
      return { valid: false, reason: pileError, engineEvents: [] };
    }

    const playedRank = allSameRank(state, cardIds);
    if (!playedRank) {
      return {
        valid: false,
        reason: "All played cards must be the same rank.",
        engineEvents: [],
      };
    }

    const topRank = getTopDiscardRank(state);
    const canPlay = isPlayable(playedRank, topRank);

    if (from === upPile) {
      const handSize = state.piles[handPile]?.size ?? 0;
      if (handSize > 0) {
        return {
          valid: false,
          reason: "You must play from your hand while you have hand cards.",
          engineEvents: [],
        };
      }

      if (!canPlay) {
        if (cardIds.length !== 1) {
          return {
            valid: false,
            reason: "Choose a single face-up card to pick up the pile.",
            engineEvents: [],
          };
        }

        const engineEvents: EngineEvent[] = [
          {
            type: "move-cards",
            fromPileId: from,
            toPileId: "discard",
            cardIds: cardIds as [number, ...number[]],
          },
        ];

        const projectedAfterPlay = projectPilesAfterEvents(state, engineEvents);
        const discardIds = projectedAfterPlay["discard"]?.cardIds ?? [];
        if (discardIds.length > 0) {
          engineEvents.push({
            type: "move-cards",
            fromPileId: "discard",
            toPileId: handPile,
            cardIds: discardIds as [number, ...number[]],
          });
        }

        const projected = projectPilesAfterEvents(state, engineEvents);
        const nextPlayer = getNextActivePlayer(playerId, players, projected);

        // Add recap message
        rulesState.recap.push(
          `${playerId}: played ${playedRank} from face-up, can't beat, picks up pile (${discardIds.length} cards)`
        );
        engineEvents.push({ type: "set-rules-state", rulesState });

        engineEvents.push({ type: "set-current-player", player: nextPlayer });
        engineEvents.push({
          type: "set-actions",
          actions: deriveActions(rulesState, nextPlayer, projected),
        });
        engineEvents.push({
          type: "set-scoreboards",
          scoreboards: buildScoreboards(projected, players),
        });

        return { valid: true, engineEvents };
      }
    }

    if (from === handPile && !canPlay) {
      return {
        valid: false,
        reason: "You must beat the pile or pick it up.",
        engineEvents: [],
      };
    }

    const engineEvents: EngineEvent[] = [
      {
        type: "move-cards",
        fromPileId: from,
        toPileId: "discard",
        cardIds: cardIds as [number, ...number[]],
      },
    ];

    return resolveAfterPlay(
      state,
      rulesState,
      players,
      playerId,
      playedRank,
      cardIds.length,
      engineEvents
    );
  },

  listLegalIntentsForPlayer(
    state: ValidationState,
    playerId: string
  ): ClientIntent[] {
    const intents: ClientIntent[] = [];
    const players = getPlayers(state);
    const rulesState = getRulesState(state.rulesState, players);
    const gameId = state.gameId;

    const pushIfValid = (intent: ClientIntent) => {
      if (this.validate(state, intent).valid) intents.push(intent);
    };

    if (!rulesState.hasDealt) {
      pushIfValid({ type: "action", gameId, playerId, action: "start-game" });
      return intents;
    }

    if (rulesState.phase === "setup") {
      if (state.currentPlayer && state.currentPlayer !== playerId) {
        return intents;
      }
      pushIfValid({ type: "action", gameId, playerId, action: "ready" });
      return intents;
    }

    if (rulesState.phase !== "play") return intents;
    if (!state.currentPlayer || state.currentPlayer !== playerId)
      return intents;

    const handPile = `${playerId}-hand`;
    const upPile = `${playerId}-up`;
    const downPile = `${playerId}-down`;
    const handCards = state.piles[handPile]?.cards ?? [];
    const upCards = state.piles[upPile]?.cards ?? [];
    const downCards = state.piles[downPile]?.cards ?? [];

    const addIndividualCardMoves = (
      fromPileId: string,
      cards: Array<{ id: number; rank: string }>,
      filterRank?: string | null
    ) => {
      for (const card of cards) {
        // If filterRank is specified, only add moves for that rank
        if (filterRank && card.rank !== filterRank) continue;

        pushIfValid({
          type: "move",
          gameId,
          playerId,
          fromPileId,
          toPileId: "discard",
          cardId: card.id,
        });
      }
    };

    const addMultiCardMoves = (
      fromPileId: string,
      cards: Array<{ id: number; rank: string }>,
      filterRank?: string | null
    ) => {
      const byRank = groupCardsByRank(cards);
      for (const [rank, cardIds] of byRank.entries()) {
        // If filterRank is specified, only add moves for that rank
        if (filterRank && rank !== filterRank) continue;

        if (cardIds.length < 2) continue;
        pushIfValid({
          type: "move",
          gameId,
          playerId,
          fromPileId,
          toPileId: "discard",
          cardIds,
        });
      }
    };

    if (handCards.length > 0) {
      const turnRank = rulesState.turnRankPlayed;

      // If a move has been made this turn, only show moves with the same rank
      if (turnRank) {
        addIndividualCardMoves(handPile, handCards, turnRank);
        addMultiCardMoves(handPile, handCards, turnRank);

        // Check if there are any more cards of the played rank
        const remainingOfRank = handCards.filter((c) => c.rank === turnRank);
        if (remainingOfRank.length > 0) {
          // Player can still play more of the same rank, so add "end-turn" action
          pushIfValid({ type: "action", gameId, playerId, action: "end-turn" });
        }
        // Note: If no cards of the played rank remain, turn will auto-end
      } else {
        // No move made yet this turn, show all possible moves
        addIndividualCardMoves(handPile, handCards);
        addMultiCardMoves(handPile, handCards);
        pushIfValid({ type: "action", gameId, playerId, action: "pick-up" });
      }

      return intents;
    }

    if (upCards.length > 0) {
      const turnRank = rulesState.turnRankPlayed;

      if (turnRank) {
        addIndividualCardMoves(upPile, upCards, turnRank);
        addMultiCardMoves(upPile, upCards, turnRank);

        const remainingOfRank = upCards.filter((c) => c.rank === turnRank);
        if (remainingOfRank.length > 0) {
          pushIfValid({ type: "action", gameId, playerId, action: "end-turn" });
        }
      } else {
        addIndividualCardMoves(upPile, upCards);
        addMultiCardMoves(upPile, upCards);
      }

      return intents;
    }

    if (downCards.length > 0) {
      pushIfValid({ type: "action", gameId, playerId, action: "flip-down" });
    }

    return intents;
  },

  listLegalIntentsForView(
    state: ValidationState,
    playerId: string
  ): ClientIntent[] {
    const intents: ClientIntent[] = [];
    const players = getPlayers(state);
    const rulesState = getRulesState(state.rulesState, players);
    const gameId = state.gameId;

    const pushIfValid = (intent: ClientIntent) => {
      if (this.validate(state, intent).valid) intents.push(intent);
    };

    if (!rulesState.hasDealt) {
      pushIfValid({ type: "action", gameId, playerId, action: "start-game" });
      return intents;
    }

    if (rulesState.phase !== "setup") {
      return this.listLegalIntentsForPlayer?.(state, playerId) ?? intents;
    }

    if (state.currentPlayer && state.currentPlayer !== playerId) {
      return intents;
    }

    const handPile = `${playerId}-hand`;
    const upPile = `${playerId}-up`;
    const handCards = state.piles[handPile]?.cards ?? [];
    const upCards = state.piles[upPile]?.cards ?? [];

    for (const card of handCards) {
      pushIfValid({
        type: "move",
        gameId,
        playerId,
        fromPileId: handPile,
        toPileId: upPile,
        cardId: card.id,
      });
    }

    for (const card of upCards) {
      pushIfValid({
        type: "move",
        gameId,
        playerId,
        fromPileId: upPile,
        toPileId: handPile,
        cardId: card.id,
      });
    }

    pushIfValid({ type: "action", gameId, playerId, action: "ready" });
    return intents;
  },
};

export const shitheadPlugin: GamePlugin = {
  id: "shithead",
  gameName: META.gameName,
  ruleModule: shitheadRules,
  description: META.description,
  validationHints: {
    sharedPileIds: ["deck", "P1-down", "P2-down", "P3-down"],
  },
  aiSupport: {
    buildContext: (view: AiView): AiContext => {
      const publicView = view.public as { rulesState?: unknown };
      const rulesState = getRulesState(publicView.rulesState, [
        "P1",
        "P2",
        "P3",
      ]);

      // Basic facts from game state (no strategy, just state reflection)
      const facts: Record<string, unknown> = {
        phase: rulesState.phase,
        currentStage:
          rulesState.phase === "setup"
            ? "Setting up (swapping hand/face-up cards)"
            : rulesState.phase === "play"
              ? "Playing"
              : rulesState.phase === "game-over"
                ? "Game over"
                : "Dealing",
      };

      // Get discard pile top card if available (what players can see)
      const piles = (
        view.public as {
          piles?: Array<{
            id: string;
            cards?: Array<{ rank?: string; suit?: string }>;
          }>;
        }
      ).piles;
      const discardPile = piles?.find((p) => p.id === "discard");
      const discardCards = discardPile?.cards ?? [];
      if (discardCards.length > 0) {
        const topCard = discardCards[discardCards.length - 1];
        if (topCard.rank) {
          facts.topDiscardCard = topCard.rank;
        }
      }

      return {
        recap: rulesState.recap.length > 0 ? rulesState.recap : undefined,
        facts,
      };
    },
  },
};
