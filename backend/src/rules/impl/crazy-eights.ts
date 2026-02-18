import { GameRuleModule, GamePlugin, ValidationHints } from "../interface.js";
import type { ValidationState } from "../../validation-state.js";
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
import {
  gatherAllCards,
  shuffleAllCards,
  distributeRoundRobin,
} from "../util/dealing.js";
import { projectPilesAfterEvents } from "../util/piles.js";
import { createRandom, fisherYates, stringToSeed } from "../../util/random.js";

const META = loadGameMeta("crazy-eights");

type Suit = "clubs" | "diamonds" | "hearts" | "spades";

interface CrazyEightsRulesState {
  phase: "setup" | "playing" | "choosing-suit" | "game-over";
  hasDealt: boolean;
  players: string[];
  dealerId: string | null;
  currentSuit: Suit | null;
  pendingSuitPlayer: string | null;
  pendingSuitNextPlayer: string | null;
  lastCardPending: string | null;
  drawPenalty: number;
  drawPenaltySuit: Suit | null;
  reshuffleCount: number;
  scores: Record<string, number>;
}

const SUITS: Suit[] = ["clubs", "diamonds", "hearts", "spades"];

const EMPTY_ACTIONS: ActionGrid = { rows: 0, cols: 0, cells: [] };

function suitLabel(suit: Suit): string {
  switch (suit) {
    case "clubs":
      return "Clubs";
    case "diamonds":
      return "Diamonds";
    case "hearts":
      return "Hearts";
    case "spades":
      return "Spades";
    default:
      return suit;
  }
}

function getPlayers(state: ValidationState): string[] {
  return state.players.map((p) => p.id);
}

function getRulesState(
  rulesState: unknown,
  players: string[]
): CrazyEightsRulesState {
  const defaultScores = Object.fromEntries(players.map((p) => [p, 0]));
  if (!rulesState || typeof rulesState !== "object") {
    return {
      phase: "setup",
      hasDealt: false,
      players,
      dealerId: null,
      currentSuit: null,
      pendingSuitPlayer: null,
      pendingSuitNextPlayer: null,
      lastCardPending: null,
      drawPenalty: 0,
      drawPenaltySuit: null,
      reshuffleCount: 0,
      scores: defaultScores,
    };
  }

  const typed = rulesState as Partial<CrazyEightsRulesState>;
  return {
    phase: typed.phase ?? "setup",
    hasDealt: typed.hasDealt ?? false,
    players: typed.players ?? players,
    dealerId: typed.dealerId ?? null,
    currentSuit: typed.currentSuit ?? null,
    pendingSuitPlayer: typed.pendingSuitPlayer ?? null,
    pendingSuitNextPlayer: typed.pendingSuitNextPlayer ?? null,
    lastCardPending: typed.lastCardPending ?? null,
    drawPenalty: typed.drawPenalty ?? 0,
    drawPenaltySuit: typed.drawPenaltySuit ?? null,
    reshuffleCount: typed.reshuffleCount ?? 0,
    scores: typed.scores ?? defaultScores,
  };
}

function getOtherPlayer(players: string[], playerId: string): string {
  return players.find((p) => p !== playerId) ?? playerId;
}

function buildSuitActions(): ActionGrid {
  return {
    rows: 2,
    cols: 2,
    cells: SUITS.map((suit, index) => ({
      id: `choose-suit:${suit}`,
      label: `Choose ${suitLabel(suit)}`,
      enabled: true,
      row: Math.floor(index / 2),
      col: index % 2,
    })),
  };
}

function addLastCardAction(actions: ActionGrid, enabled: boolean): ActionGrid {
  const hasLastCard = actions.cells.some(
    (cell) => cell.id === "call-last-card"
  );
  if (hasLastCard) return actions;
  const cols = Math.max(actions.cols, 1);
  const row = actions.rows === 0 ? 0 : actions.rows;
  const rows = row + 1;
  return {
    rows,
    cols,
    cells: [
      ...actions.cells,
      {
        id: "call-last-card",
        label: "Last card",
        enabled,
        row,
        col: 0,
      },
    ],
  };
}

function deriveActions(
  rulesState: CrazyEightsRulesState,
  currentPlayer: string | null
): ActionGrid {
  if (!rulesState.hasDealt || rulesState.phase === "game-over") {
    return EMPTY_ACTIONS;
  }

  let actions = EMPTY_ACTIONS;
  if (rulesState.pendingSuitPlayer) {
    actions = buildSuitActions();
  }

  if (rulesState.lastCardPending) {
    actions = addLastCardAction(
      actions,
      currentPlayer === rulesState.lastCardPending
    );
  }

  return actions;
}

function scoreCard(rank: string): number {
  if (rank === "8") return 50;
  if (rank === "J" || rank === "Q" || rank === "K") return 10;
  if (rank === "A") return 1;
  const parsed = Number(rank);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function buildScoreboards(
  state: ValidationState,
  rulesState: CrazyEightsRulesState,
  projected = projectPilesAfterEvents(state, []),
  currentPlayerOverride: string | null = null
): Scoreboard[] {
  const players = rulesState.players;
  const rows = players.length + 2;
  const cols = 2;
  const cells: Scoreboard["cells"] = [
    { row: 0, col: 0, text: "Player", role: "header" },
    { row: 0, col: 1, text: "Points", role: "header" },
  ];

  players.forEach((playerId, index) => {
    const score = rulesState.scores[playerId] ?? 0;
    cells.push({
      row: index + 1,
      col: 0,
      text: playerId,
      role: "body",
    });
    cells.push({
      row: index + 1,
      col: 1,
      text: String(score),
      role: "body",
    });
  });

  const suitText = rulesState.currentSuit
    ? `Suit: ${suitLabel(rulesState.currentSuit)}`
    : "Suit: ?";
  const currentPlayer = currentPlayerOverride ?? state.currentPlayer;
  const turnText = currentPlayer ? `Turn: ${currentPlayer}` : "Turn: -";
  const status = rulesState.phase === "game-over" ? "Game over" : "Playing";
  const stockSize = projected["deck"]?.size ?? 0;
  const drawText =
    rulesState.drawPenalty > 0 ? ` • Draw: ${rulesState.drawPenalty}` : "";

  cells.push({
    row: rows - 1,
    col: 0,
    colspan: 2,
    text: `${status} • ${turnText} • ${suitText} • Stock: ${stockSize}${drawText}`,
    role: "body",
  });

  return [
    {
      id: "crazy-eights-score",
      title: "Crazy Eights",
      rows,
      cols,
      cells,
    },
  ];
}

function computePenaltyPoints(
  state: ValidationState,
  cardIds: number[]
): number {
  let total = 0;
  for (const cardId of cardIds) {
    const card = state.allCards[cardId];
    if (!card) continue;
    total += scoreCard(card.rank);
  }
  return total;
}

function getTopDiscardId(
  state: ValidationState,
  projected?: ReturnType<typeof projectPilesAfterEvents>
): number | null {
  const projectedDiscard = projected?.["discard"]?.cardIds;
  const discardCards =
    projectedDiscard ?? state.piles["discard"]?.cards?.map((c) => c.id) ?? [];
  if (discardCards.length === 0) return null;
  return discardCards[discardCards.length - 1] ?? null;
}

function getPileCardIds(
  state: ValidationState,
  pileId: string,
  projected?: ReturnType<typeof projectPilesAfterEvents>
): number[] {
  if (projected && projected[pileId]?.cardIds) {
    return projected[pileId]?.cardIds ?? [];
  }
  return state.piles[pileId]?.cards?.map((c) => c.id) ?? [];
}

function isCardPlayable(
  playedCard: { rank: string; suit: string },
  topDiscard: { rank: string; suit: string },
  rulesState: CrazyEightsRulesState
): boolean {
  const isEight = playedCard.rank === "8";
  const isTwo = playedCard.rank === "2";
  const topIsEight = topDiscard.rank === "8";
  const requiredSuit = rulesState.currentSuit ?? (topDiscard.suit as Suit);

  if (rulesState.drawPenalty > 0 && !isTwo) return false;

  return (
    isEight ||
    (!topIsEight &&
      (playedCard.rank === topDiscard.rank ||
        playedCard.suit === topDiscard.suit)) ||
    (topIsEight &&
      (playedCard.rank === "8" || playedCard.suit === requiredSuit))
  );
}

function hasPlayableDiscardMove(
  state: ValidationState,
  rulesState: CrazyEightsRulesState,
  playerId: string,
  projected?: ReturnType<typeof projectPilesAfterEvents>
): boolean {
  const handCardIds = getPileCardIds(state, `${playerId}-hand`, projected);
  if (handCardIds.length === 0) return false;

  const topDiscardId = getTopDiscardId(state, projected);
  if (!topDiscardId) return false;
  const topDiscard = state.allCards[topDiscardId];
  if (!topDiscard) return false;

  for (const cardId of handCardIds) {
    const card = state.allCards[cardId];
    if (!card) continue;
    if (isCardPlayable(card, topDiscard, rulesState)) {
      return true;
    }
  }

  return false;
}

function resolveBlockedHand(
  state: ValidationState,
  rulesState: CrazyEightsRulesState,
  projected: ReturnType<typeof projectPilesAfterEvents>
): ValidationResult {
  const players = rulesState.players;
  const playerScores = Object.fromEntries(
    players.map((playerId) => {
      const handIds = getPileCardIds(state, `${playerId}-hand`, projected);
      return [playerId, computePenaltyPoints(state, handIds)];
    })
  ) as Record<string, number>;

  const sorted = [...players].sort((a, b) => {
    const diff = (playerScores[a] ?? 0) - (playerScores[b] ?? 0);
    if (diff !== 0) return diff;
    return a.localeCompare(b);
  });
  const winner = sorted[0] ?? players[0] ?? null;

  const nextRulesState: CrazyEightsRulesState = {
    ...rulesState,
    phase: "game-over",
    pendingSuitPlayer: null,
    pendingSuitNextPlayer: null,
    lastCardPending: null,
    drawPenalty: 0,
    drawPenaltySuit: null,
    scores: {
      ...rulesState.scores,
      ...playerScores,
    },
  };

  const engineEvents: EngineEvent[] = [
    ...(winner ? [{ type: "set-winner", winner } as const] : []),
    { type: "set-current-player", player: null },
    { type: "set-rules-state", rulesState: nextRulesState },
    { type: "set-actions", actions: EMPTY_ACTIONS },
    {
      type: "set-scoreboards",
      scoreboards: buildScoreboards(state, nextRulesState, projected, null),
    },
  ];

  return {
    valid: true,
    engineEvents,
  };
}

function drawCards(
  state: ValidationState,
  rulesState: CrazyEightsRulesState,
  targetPlayerId: string,
  count: number,
  options: {
    allowPartial?: boolean;
    projected?: ReturnType<typeof projectPilesAfterEvents>;
  } = {}
): {
  events: EngineEvent[];
  nextRulesState: CrazyEightsRulesState;
  drawn: number;
  reason?: string;
} {
  const events: EngineEvent[] = [];
  let nextRulesState: CrazyEightsRulesState = { ...rulesState };

  let deckCardIds = getPileCardIds(state, "deck", options.projected);
  let discardCardIds = getPileCardIds(state, "discard", options.projected);

  const reshuffleIfNeeded = (): boolean => {
    if (deckCardIds.length > 0) return true;
    if (discardCardIds.length <= 1) return false;

    const topDiscard = discardCardIds[discardCardIds.length - 1] as number;
    const toShuffle = discardCardIds.slice(0, -1);
    const baseSeed = stringToSeed(state.seed || "CRAZY_EIGHTS");
    const random = createRandom(baseSeed + nextRulesState.reshuffleCount + 1);
    const shuffled = fisherYates([...toShuffle], random);

    for (const cardId of shuffled) {
      events.push({
        type: "move-cards",
        fromPileId: "discard",
        toPileId: "deck",
        cardIds: [cardId],
      });
    }

    discardCardIds = [topDiscard];
    deckCardIds = [...shuffled];
    nextRulesState = {
      ...nextRulesState,
      reshuffleCount: nextRulesState.reshuffleCount + 1,
    };

    return deckCardIds.length > 0;
  };

  let drawn = 0;
  while (drawn < count) {
    if (!reshuffleIfNeeded()) {
      if (options.allowPartial && drawn > 0) break;
      return {
        events: [],
        nextRulesState: rulesState,
        drawn: 0,
        reason: "Stock is empty.",
      };
    }

    const cardId = deckCardIds.pop();
    if (!cardId) break;
    events.push({
      type: "move-cards",
      fromPileId: "deck",
      toPileId: `${targetPlayerId}-hand`,
      cardIds: [cardId],
    });
    drawn++;
  }

  return { events, nextRulesState, drawn };
}

function appendReshuffleIfNeeded(
  state: ValidationState,
  rulesState: CrazyEightsRulesState,
  engineEvents: EngineEvent[],
  projected?: ReturnType<typeof projectPilesAfterEvents>
): {
  nextRulesState: CrazyEightsRulesState;
  projected: ReturnType<typeof projectPilesAfterEvents>;
} {
  let nextRulesState = rulesState;
  let nextProjected = projected ?? projectPilesAfterEvents(state, engineEvents);

  const deckCardIds = nextProjected["deck"]?.cardIds ?? [];
  const discardCardIds = nextProjected["discard"]?.cardIds ?? [];

  if (deckCardIds.length > 0 || discardCardIds.length <= 1) {
    return { nextRulesState, projected: nextProjected };
  }

  const toShuffle = discardCardIds.slice(0, -1);
  const baseSeed = stringToSeed(state.seed || "CRAZY_EIGHTS");
  const random = createRandom(baseSeed + nextRulesState.reshuffleCount + 1);
  const shuffled = fisherYates([...toShuffle], random);

  for (const cardId of shuffled) {
    engineEvents.push({
      type: "move-cards",
      fromPileId: "discard",
      toPileId: "deck",
      cardIds: [cardId],
    });
  }

  nextRulesState = {
    ...nextRulesState,
    reshuffleCount: nextRulesState.reshuffleCount + 1,
  };
  nextProjected = projectPilesAfterEvents(state, engineEvents);

  return { nextRulesState, projected: nextProjected };
}

export const crazyEightsRules: GameRuleModule = {
  listLegalIntentsForPlayer(
    state: ValidationState,
    playerId: string
  ): ClientIntent[] {
    const players = getPlayers(state);
    const rulesState = getRulesState(state.rulesState, players);
    const intents: ClientIntent[] = [];
    const gameId = state.gameId;

    if (state.winner || rulesState.phase === "game-over") {
      return intents;
    }

    if (!rulesState.hasDealt) {
      intents.push({ type: "action", gameId, playerId, action: "start-game" });
      return intents;
    }

    if (rulesState.pendingSuitPlayer) {
      if (rulesState.pendingSuitPlayer === playerId) {
        intents.push(
          ...SUITS.map(
            (suit) =>
              ({
                type: "action",
                gameId,
                playerId,
                action: `choose-suit:${suit}`,
              }) as const
          )
        );
      }
      return intents;
    }

    if (rulesState.lastCardPending === playerId) {
      intents.push({
        type: "action",
        gameId,
        playerId,
        action: "call-last-card",
      });
    }

    if (!state.currentPlayer || state.currentPlayer !== playerId) {
      return intents.filter((intent) => this.validate(state, intent).valid);
    }

    const deckCardIds = getPileCardIds(state, "deck");
    const topDeckId = deckCardIds[deckCardIds.length - 1] ?? null;
    intents.push({
      type: "move",
      gameId,
      playerId,
      fromPileId: "deck",
      toPileId: `${playerId}-hand`,
      ...(topDeckId ? { cardId: topDeckId } : {}),
    });

    const handPileId = `${playerId}-hand`;
    const hand = state.piles[handPileId];
    if (hand?.cards) {
      for (const card of hand.cards) {
        intents.push({
          type: "move",
          gameId,
          playerId,
          fromPileId: handPileId,
          toPileId: "discard",
          cardId: card.id,
        });
      }
    }

    return intents.filter((intent) => this.validate(state, intent).valid);
  },
  validate(state: ValidationState, intent: ClientIntent): ValidationResult {
    const players = getPlayers(state);
    if (players.length !== 2) {
      return {
        valid: false,
        reason: "Crazy Eights is configured for exactly 2 players.",
        engineEvents: [],
      };
    }

    const rulesState = getRulesState(state.rulesState, players);
    if (state.winner || rulesState.phase === "game-over") {
      return {
        valid: false,
        reason: "Game is already over.",
        engineEvents: [],
      };
    }

    const engineEvents: EngineEvent[] = [];
    let nextRulesState: CrazyEightsRulesState = { ...rulesState };
    let projectedAfterPenalty: ReturnType<
      typeof projectPilesAfterEvents
    > | null = null;

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
          reason: "Crazy Eights requires a 52-card deck.",
          engineEvents: [],
        };
      }

      engineEvents.push(
        ...gatherAllCards(state, { previousEvents: engineEvents })
      );

      const dealNumber = 1;
      const shuffled = shuffleAllCards(state, dealNumber, "CRAZY_EIGHTS", {
        useCurrentDeckIfFull: false,
      });

      const dealerIndex =
        stringToSeed(state.seed || "CRAZY_EIGHTS") % players.length;
      const dealerId = players[dealerIndex] ?? players[0];
      const firstPlayer = getOtherPlayer(players, dealerId);

      const { events: dealEvents, nextIndex } = distributeRoundRobin(
        shuffled,
        players.map((p) => `${p}-hand`),
        7
      );
      engineEvents.push(...dealEvents);

      const startCardId = shuffled[nextIndex];
      engineEvents.push({
        type: "move-cards",
        fromPileId: "deck",
        toPileId: "discard",
        cardIds: [startCardId],
      });

      const startCard = state.allCards[startCardId];
      const startRank = startCard?.rank ?? null;
      const startSuit = (startCard?.suit as Suit | undefined) ?? null;
      const isEight = startRank === "8";
      const isTwo = startRank === "2";
      const isQueen = startRank === "Q";
      nextRulesState = {
        ...nextRulesState,
        phase: isEight ? "choosing-suit" : "playing",
        hasDealt: true,
        dealerId,
        currentSuit: isEight ? null : startSuit,
        pendingSuitPlayer: isEight ? dealerId : null,
        pendingSuitNextPlayer: isEight ? firstPlayer : null,
        lastCardPending: null,
        drawPenalty: isTwo ? 2 : 0,
        drawPenaltySuit: isTwo ? startSuit : null,
        reshuffleCount: 0,
        scores: Object.fromEntries(players.map((p) => [p, 0])),
      };

      engineEvents.push({
        type: "set-current-player",
        player: isEight ? dealerId : isQueen ? dealerId : firstPlayer,
      });
      engineEvents.push({
        type: "set-rules-state",
        rulesState: nextRulesState,
      });
      const projected = projectPilesAfterEvents(state, engineEvents);
      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: buildScoreboards(
          state,
          nextRulesState,
          projected,
          isEight ? dealerId : isQueen ? dealerId : firstPlayer
        ),
      });
      engineEvents.push({
        type: "set-actions",
        actions: deriveActions(
          nextRulesState,
          isEight ? dealerId : isQueen ? dealerId : firstPlayer
        ),
      });

      return { valid: true, engineEvents };
    }

    // Allow calling "last card" out of turn
    if (intent.type === "action" && intent.action === "call-last-card") {
      if (rulesState.lastCardPending !== intent.playerId) {
        return {
          valid: false,
          reason: "You can only call last card for your own hand.",
          engineEvents: [],
        };
      }

      nextRulesState = { ...nextRulesState, lastCardPending: null };
      engineEvents.push({
        type: "set-rules-state",
        rulesState: nextRulesState,
      });
      engineEvents.push({
        type: "set-actions",
        actions: deriveActions(nextRulesState, state.currentPlayer),
      });
      const projected = projectPilesAfterEvents(state, engineEvents);
      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: buildScoreboards(
          state,
          nextRulesState,
          projected,
          state.currentPlayer
        ),
      });

      return { valid: true, engineEvents };
    }

    // Apply penalty for missed "last card" before the next player acts
    if (
      rulesState.lastCardPending &&
      state.currentPlayer &&
      intent.playerId === state.currentPlayer &&
      intent.playerId !== rulesState.lastCardPending
    ) {
      const penalty = drawCards(
        state,
        nextRulesState,
        rulesState.lastCardPending,
        2,
        { allowPartial: true }
      );
      engineEvents.push(...penalty.events);
      nextRulesState = {
        ...penalty.nextRulesState,
        lastCardPending: null,
      };
      projectedAfterPenalty = projectPilesAfterEvents(state, engineEvents);
    }

    if (nextRulesState.pendingSuitPlayer) {
      if (intent.type !== "action") {
        return {
          valid: false,
          reason: "You must choose a suit after playing an Eight.",
          engineEvents: [],
        };
      }

      const action = intent.action ?? "";
      if (!action.startsWith("choose-suit:")) {
        return {
          valid: false,
          reason: "Choose a suit to continue.",
          engineEvents: [],
        };
      }

      if (intent.playerId !== nextRulesState.pendingSuitPlayer) {
        return {
          valid: false,
          reason: "Only the player who played the Eight can choose the suit.",
          engineEvents: [],
        };
      }

      const suit = action.replace("choose-suit:", "") as Suit;
      if (!SUITS.includes(suit)) {
        return {
          valid: false,
          reason: "Invalid suit choice.",
          engineEvents: [],
        };
      }

      const nextPlayer = nextRulesState.pendingSuitNextPlayer;
      nextRulesState = {
        ...nextRulesState,
        phase: "playing",
        currentSuit: suit,
        pendingSuitPlayer: null,
        pendingSuitNextPlayer: null,
      };

      const reshuffle = appendReshuffleIfNeeded(
        state,
        nextRulesState,
        engineEvents
      );
      nextRulesState = reshuffle.nextRulesState;
      const projected = reshuffle.projected;

      engineEvents.push({
        type: "set-current-player",
        player: nextPlayer,
      });
      engineEvents.push({
        type: "set-rules-state",
        rulesState: nextRulesState,
      });
      engineEvents.push({
        type: "set-actions",
        actions: deriveActions(nextRulesState, nextPlayer),
      });
      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: buildScoreboards(
          state,
          nextRulesState,
          projected,
          nextPlayer
        ),
      });

      return { valid: true, engineEvents };
    }

    if (intent.playerId !== state.currentPlayer) {
      return {
        valid: false,
        reason: "It is not your turn.",
        engineEvents: [],
      };
    }

    if (
      intent.type === "move" &&
      intent.fromPileId === "deck" &&
      intent.toPileId === `${intent.playerId}-hand`
    ) {
      const projected =
        projectedAfterPenalty ?? projectPilesAfterEvents(state, engineEvents);
      const deckCardIds = getPileCardIds(state, "deck", projected);
      const discardCardIds = getPileCardIds(state, "discard", projected);
      const topDeckId = deckCardIds[deckCardIds.length - 1] ?? null;
      const canReshuffle = !topDeckId && discardCardIds.length > 1;
      if (!topDeckId && !canReshuffle) {
        const hasPlayable = hasPlayableDiscardMove(
          state,
          nextRulesState,
          intent.playerId,
          projected
        );
        if (hasPlayable) {
          return { valid: false, reason: "Stock is empty.", engineEvents: [] };
        }

        return resolveBlockedHand(state, nextRulesState, projected);
      }

      if (topDeckId && intent.cardId == null) {
        return {
          valid: false,
          reason: "You must draw the top card from the stock.",
          engineEvents: [],
        };
      }

      if (topDeckId && intent.cardId !== topDeckId) {
        return {
          valid: false,
          reason: "You must draw the top card from the stock.",
          engineEvents: [],
        };
      }

      const drawCount = rulesState.drawPenalty > 0 ? rulesState.drawPenalty : 1;
      const draw = drawCards(
        state,
        nextRulesState,
        intent.playerId,
        drawCount,
        {
          allowPartial: rulesState.drawPenalty > 0,
          projected,
        }
      );
      if (draw.reason) {
        return { valid: false, reason: draw.reason, engineEvents: [] };
      }

      engineEvents.push(...draw.events);
      nextRulesState = {
        ...draw.nextRulesState,
        drawPenalty: 0,
        drawPenaltySuit: null,
      };

      const nextPlayer = getOtherPlayer(players, intent.playerId);

      if (nextRulesState.lastCardPending === intent.playerId) {
        nextRulesState = { ...nextRulesState, lastCardPending: null };
      }

      const reshuffle = appendReshuffleIfNeeded(
        state,
        nextRulesState,
        engineEvents
      );
      nextRulesState = reshuffle.nextRulesState;
      const projectedAfterDraw = reshuffle.projected;

      engineEvents.push({
        type: "set-current-player",
        player: nextPlayer,
      });
      engineEvents.push({
        type: "set-rules-state",
        rulesState: nextRulesState,
      });
      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: buildScoreboards(
          state,
          nextRulesState,
          projectedAfterDraw,
          nextPlayer
        ),
      });
      engineEvents.push({
        type: "set-actions",
        actions: deriveActions(nextRulesState, nextPlayer),
      });

      return { valid: true, engineEvents };
    }

    if (intent.type !== "move") {
      return {
        valid: false,
        reason: "Invalid action.",
        engineEvents: [],
      };
    }

    if (
      intent.fromPileId !== `${intent.playerId}-hand` ||
      intent.toPileId !== "discard"
    ) {
      return {
        valid: false,
        reason: "You must play a card from your hand to the discard pile.",
        engineEvents: [],
      };
    }

    const handPile = state.piles[intent.fromPileId];
    if (!handPile?.cards) {
      return {
        valid: false,
        reason: "Your hand is not visible.",
        engineEvents: [],
      };
    }

    const playedCard = handPile.cards.find((c) => c.id === intent.cardId);
    if (!playedCard) {
      return {
        valid: false,
        reason: "Card not found in hand.",
        engineEvents: [],
      };
    }

    const topDiscardId = getTopDiscardId(state);
    if (!topDiscardId) {
      return {
        valid: false,
        reason: "Discard pile is empty.",
        engineEvents: [],
      };
    }

    const topDiscard = state.allCards[topDiscardId];
    if (!topDiscard) {
      return {
        valid: false,
        reason: "Discard pile is invalid.",
        engineEvents: [],
      };
    }

    const isEight = playedCard.rank === "8";
    const isTwo = playedCard.rank === "2";
    const topIsEight = topDiscard.rank === "8";
    const requiredSuit = rulesState.currentSuit ?? topDiscard.suit;

    if (rulesState.drawPenalty > 0 && !isTwo) {
      return {
        valid: false,
        reason: "A Two must be played or the penalty must be drawn.",
        engineEvents: [],
      };
    }

    const isLegal =
      isEight ||
      (!topIsEight &&
        (playedCard.rank === topDiscard.rank ||
          playedCard.suit === topDiscard.suit)) ||
      (topIsEight &&
        (playedCard.rank === "8" || playedCard.suit === requiredSuit));

    if (!isLegal) {
      return {
        valid: false,
        reason: "That card does not match the rank or suit.",
        engineEvents: [],
      };
    }

    engineEvents.push({
      type: "move-cards",
      fromPileId: intent.fromPileId,
      toPileId: "discard",
      cardIds: [intent.cardId!],
    });

    const projectedAfterPlay = projectPilesAfterEvents(state, engineEvents);
    const remaining = projectedAfterPlay[intent.fromPileId]?.size ?? 0;

    if (remaining === 0) {
      const opponent = getOtherPlayer(players, intent.playerId);
      const opponentHand =
        projectedAfterPlay[`${opponent}-hand`]?.cardIds ?? [];
      const opponentScore = computePenaltyPoints(state, opponentHand);
      nextRulesState = {
        ...nextRulesState,
        phase: "game-over",
        currentSuit: isEight
          ? rulesState.currentSuit
          : (playedCard.suit as Suit),
        pendingSuitPlayer: null,
        pendingSuitNextPlayer: null,
        lastCardPending: null,
        drawPenalty: 0,
        drawPenaltySuit: null,
        scores: {
          ...nextRulesState.scores,
          [opponent]: opponentScore,
        },
      };

      engineEvents.push({ type: "set-winner", winner: intent.playerId });
      engineEvents.push({ type: "set-current-player", player: null });
      engineEvents.push({
        type: "set-rules-state",
        rulesState: nextRulesState,
      });
      engineEvents.push({
        type: "set-actions",
        actions: EMPTY_ACTIONS,
      });
      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: buildScoreboards(
          state,
          nextRulesState,
          projectedAfterPlay,
          null
        ),
      });

      return { valid: true, engineEvents };
    }

    if (remaining === 1) {
      nextRulesState = { ...nextRulesState, lastCardPending: intent.playerId };
    }

    let nextPlayer: string | null = null;
    if (isEight) {
      nextRulesState = {
        ...nextRulesState,
        phase: "choosing-suit",
        pendingSuitPlayer: intent.playerId,
        pendingSuitNextPlayer: getOtherPlayer(players, intent.playerId),
        drawPenalty: 0,
        drawPenaltySuit: null,
      };
      nextPlayer = intent.playerId;
    } else if (isTwo) {
      nextRulesState = {
        ...nextRulesState,
        phase: "playing",
        currentSuit: playedCard.suit as Suit,
        pendingSuitPlayer: null,
        pendingSuitNextPlayer: null,
        drawPenalty: nextRulesState.drawPenalty + 2,
        drawPenaltySuit: playedCard.suit as Suit,
      };
      const next = getOtherPlayer(players, intent.playerId);
      nextPlayer = next;
    } else {
      nextRulesState = {
        ...nextRulesState,
        phase: "playing",
        currentSuit: playedCard.suit as Suit,
        pendingSuitPlayer: null,
        pendingSuitNextPlayer: null,
        drawPenalty: 0,
        drawPenaltySuit: null,
      };
      const next =
        playedCard.rank === "Q"
          ? intent.playerId
          : getOtherPlayer(players, intent.playerId);
      nextPlayer = next;
    }

    const reshuffle = appendReshuffleIfNeeded(
      state,
      nextRulesState,
      engineEvents,
      projectedAfterPlay
    );
    nextRulesState = reshuffle.nextRulesState;
    const projectedAfterReshuffle = reshuffle.projected;

    engineEvents.push({
      type: "set-current-player",
      player: nextPlayer,
    });
    engineEvents.push({
      type: "set-rules-state",
      rulesState: nextRulesState,
    });
    engineEvents.push({
      type: "set-scoreboards",
      scoreboards: buildScoreboards(
        state,
        nextRulesState,
        projectedAfterReshuffle,
        nextPlayer
      ),
    });
    engineEvents.push({
      type: "set-actions",
      actions: deriveActions(nextRulesState, nextPlayer),
    });

    return { valid: true, engineEvents };
  },
};

export const crazyEightsPlugin: GamePlugin = {
  id: "crazy-eights",
  gameName: META.gameName,
  ruleModule: crazyEightsRules,
  description: META.description,
  validationHints: {
    isPileAlwaysVisibleToRules: (pileId) =>
      pileId === "deck" || pileId === "discard" || pileId.endsWith("-hand"),
  } satisfies ValidationHints,
};
