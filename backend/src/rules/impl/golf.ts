import type { GamePlugin, GameRuleModule } from "../interface.js";
import type { ValidationState } from "../../validation-state.js";
import type { ClientIntent, Scoreboard } from "../../../../shared/schemas.js";
import type {
  EngineEvent,
  ValidationResult,
} from "../../../../shared/validation.js";
import { loadGameMeta } from "../meta.js";
import { gatherAllCards, shuffleAllCards } from "../util/dealing.js";
import { projectPilesAfterEvents } from "../util/piles.js";

const META = loadGameMeta("golf");

const MAX_DEALS = 9;
const DEAL_POSITIONS = [
  "far-left",
  "far-right",
  "near-left",
  "near-right",
] as const;

type TurnPhase = "turn" | "drawn";
type DrawSource = "stock" | "discard" | null;
type RoundPhase = "deal" | "peek" | "play";

interface GolfRulesState {
  players: string[];
  hasDealt: boolean;
  dealNumber: number;
  dealerIndex: number;
  phase: RoundPhase;
  firstPlayer: string | null;
  turnPhase: TurnPhase;
  drawnFrom: DrawSource;
  knockedBy: string | null;
  finalTurnsRemaining: number;
  peekReady: Record<string, boolean>;
  scores: Record<string, number>;
  lastHandScores: Record<string, number>;
}

const CARD_VALUES: Record<string, number> = {
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
  K: 0,
};

function getPlayers(state: ValidationState): string[] {
  if (state.players && state.players.length > 0) {
    return state.players.map((p) => p.id);
  }
  return ["P1", "P2"];
}

function normalizeScores(
  value: unknown,
  players: string[],
  fallback: Record<string, number>
): Record<string, number> {
  const next = { ...fallback };
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const playerId of players) {
      const entry = record[playerId];
      if (typeof entry === "number") next[playerId] = entry;
    }
  }
  return next;
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

function getRulesState(obj: unknown, players: string[]): GolfRulesState {
  const base: GolfRulesState = {
    players,
    hasDealt: false,
    dealNumber: 0,
    dealerIndex: 0,
    phase: "deal",
    firstPlayer: null,
    turnPhase: "turn",
    drawnFrom: null,
    knockedBy: null,
    finalTurnsRemaining: 0,
    peekReady: Object.fromEntries(players.map((p) => [p, false])),
    scores: Object.fromEntries(players.map((p) => [p, 0])),
    lastHandScores: Object.fromEntries(players.map((p) => [p, 0])),
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
    dealerIndex:
      typeof o.dealerIndex === "number" ? o.dealerIndex : base.dealerIndex,
    phase:
      o.phase === "deal" || o.phase === "peek" || o.phase === "play"
        ? (o.phase as RoundPhase)
        : base.phase,
    firstPlayer:
      typeof o.firstPlayer === "string" ? o.firstPlayer : base.firstPlayer,
    turnPhase:
      o.turnPhase === "turn" || o.turnPhase === "drawn"
        ? (o.turnPhase as TurnPhase)
        : base.turnPhase,
    drawnFrom:
      o.drawnFrom === "stock" || o.drawnFrom === "discard"
        ? (o.drawnFrom as DrawSource)
        : null,
    knockedBy: typeof o.knockedBy === "string" ? o.knockedBy : null,
    finalTurnsRemaining:
      typeof o.finalTurnsRemaining === "number"
        ? o.finalTurnsRemaining
        : base.finalTurnsRemaining,
    peekReady: normalizeReady(o.peekReady, resolvedPlayers, base.peekReady),
    scores: normalizeScores(o.scores, resolvedPlayers, base.scores),
    lastHandScores: normalizeScores(
      o.lastHandScores,
      resolvedPlayers,
      base.lastHandScores
    ),
  };
}

function layoutPileIds(playerId: string): string[] {
  return [
    `${playerId}-near-left`,
    `${playerId}-near-right`,
    `${playerId}-far-left`,
    `${playerId}-far-right`,
  ];
}

function drawPileId(playerId: string): string {
  return `${playerId}-draw`;
}

function getNextPlayer(current: string, players: string[]): string {
  const index = players.indexOf(current);
  if (index === -1) return players[0];
  return players[(index + 1) % players.length];
}

function rotatePlayers(players: string[], startIndex: number): string[] {
  if (players.length === 0) return [];
  const idx = ((startIndex % players.length) + players.length) % players.length;
  return [...players.slice(idx), ...players.slice(0, idx)];
}

function buildScoreboards(rulesState: GolfRulesState): Scoreboard[] {
  const dealLabel = Math.max(rulesState.dealNumber, 0);
  return [
    {
      id: "golf-score",
      title: `Score (Deal ${dealLabel}/${MAX_DEALS})`,
      rows: 3,
      cols: 3,
      cells: [
        { row: 0, col: 0, text: "Player", role: "header" },
        { row: 0, col: 1, text: "Total", role: "header" },
        { row: 0, col: 2, text: "Last Hand", role: "header" },
        { row: 1, col: 0, text: "P1", role: "body" },
        {
          row: 1,
          col: 1,
          text: String(rulesState.scores["P1"] ?? 0),
          role: "body",
        },
        {
          row: 1,
          col: 2,
          text: String(rulesState.lastHandScores["P1"] ?? 0),
          role: "body",
        },
        { row: 2, col: 0, text: "P2", role: "body" },
        {
          row: 2,
          col: 1,
          text: String(rulesState.scores["P2"] ?? 0),
          role: "body",
        },
        {
          row: 2,
          col: 2,
          text: String(rulesState.lastHandScores["P2"] ?? 0),
          role: "body",
        },
      ],
    },
  ];
}

function deriveActions(
  state: ValidationState,
  rulesState: GolfRulesState,
  currentPlayerId: string | null
) {
  if (!rulesState.hasDealt) return { rows: 0, cols: 0, cells: [] };
  if (state.winner) return { rows: 0, cols: 0, cells: [] };

  if (rulesState.phase === "peek") {
    return {
      rows: 1,
      cols: 1,
      cells: [
        {
          id: "ready",
          label: "Ready",
          enabled: true,
          row: 0,
          col: 0,
        },
      ],
    };
  }

  if (rulesState.phase !== "play") return { rows: 0, cols: 0, cells: [] };
  if (!currentPlayerId) return { rows: 0, cols: 0, cells: [] };
  if (rulesState.turnPhase !== "turn") return { rows: 0, cols: 0, cells: [] };

  const cells = [
    {
      id: "knock",
      label: "Knock",
      row: 0,
      col: 0,
      enabled: rulesState.knockedBy === null,
    },
  ];

  return {
    rows: 1,
    cols: 1,
    cells,
  };
}

function getTopDeckCardId(state: ValidationState): number | null {
  const deck = state.piles["deck"];
  if (deck?.cards && deck.cards.length > 0) {
    return deck.cards[deck.cards.length - 1].id;
  }
  return deck?.topCard?.id ?? null;
}

function getTopDiscardCardId(state: ValidationState): number | null {
  const discard = state.piles["discard"];
  if (discard?.cards && discard.cards.length > 0) {
    return discard.cards[discard.cards.length - 1].id;
  }
  return discard?.topCard?.id ?? null;
}

function scoreLayout(
  projected: Record<
    string,
    { cardIds?: number[]; cards?: { id: number; rank: string; suit: string }[] }
  >,
  state: ValidationState,
  playerId: string
): number {
  let score = 0;
  for (const pileId of layoutPileIds(playerId)) {
    const pile = projected[pileId];
    const cardId = pile?.cardIds?.[0];
    if (!cardId) continue;
    const card =
      pile?.cards?.find((c) => c.id === cardId) ?? state.allCards[cardId];
    if (!card) continue;
    score += CARD_VALUES[card.rank] ?? 0;
  }
  return score;
}

export const golfRules: GameRuleModule = {
  listLegalIntentsForPlayer(
    state: ValidationState,
    playerId: string
  ): ClientIntent[] {
    const intents: ClientIntent[] = [];
    const players = getPlayers(state);
    const rulesState = getRulesState(state.rulesState, players);
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

    if (rulesState.phase === "peek") {
      const readyIntent: ClientIntent = {
        type: "action",
        gameId,
        playerId,
        action: "ready",
      };
      if (this.validate(state, readyIntent).valid) intents.push(readyIntent);
      return intents;
    }

    if (rulesState.phase !== "play") return intents;

    if (!state.currentPlayer || state.currentPlayer !== playerId)
      return intents;

    if (rulesState.turnPhase === "turn") {
      const topDeckId = getTopDeckCardId(state);
      if (topDeckId) {
        intents.push({
          type: "move",
          gameId,
          playerId,
          fromPileId: "deck",
          toPileId: drawPileId(playerId),
          cardId: topDeckId,
        });
      }
      const topDiscardId = getTopDiscardCardId(state);
      if (topDiscardId) {
        intents.push({
          type: "move",
          gameId,
          playerId,
          fromPileId: "discard",
          toPileId: drawPileId(playerId),
          cardId: topDiscardId,
        });
      }
      if (rulesState.knockedBy === null) {
        intents.push({ type: "action", gameId, playerId, action: "knock" });
      }
      return intents.filter((intent) => this.validate(state, intent).valid);
    }

    const drawPile = state.piles[drawPileId(playerId)];
    const drawnCardId = drawPile?.cards?.[0]?.id;
    if (!drawnCardId) return intents;

    for (const pileId of layoutPileIds(playerId)) {
      const candidate: ClientIntent = {
        type: "move",
        gameId,
        playerId,
        fromPileId: drawPileId(playerId),
        toPileId: pileId,
        cardId: drawnCardId,
      };
      if (this.validate(state, candidate).valid) intents.push(candidate);
    }

    const discardCandidate: ClientIntent = {
      type: "move",
      gameId,
      playerId,
      fromPileId: drawPileId(playerId),
      toPileId: "discard",
      cardId: drawnCardId,
    };
    if (this.validate(state, discardCandidate).valid) {
      intents.push(discardCandidate);
    }

    return intents;
  },

  validate(state: ValidationState, intent: ClientIntent): ValidationResult {
    const players = getPlayers(state);
    const rulesState = getRulesState(state.rulesState, players);
    const engineEvents: EngineEvent[] = [];
    let nextRulesState: GolfRulesState = { ...rulesState, players };

    if (state.winner) {
      return {
        valid: false,
        reason: "The game is already finished.",
        engineEvents: [],
      };
    }

    if (!rulesState.hasDealt) {
      if (intent.type !== "action" || intent.action !== "start-game") {
        return {
          valid: false,
          reason: "Use the 'Start Game' action to deal.",
          engineEvents: [],
        };
      }

      if (rulesState.dealNumber >= MAX_DEALS) {
        return {
          valid: false,
          reason: "The match is complete.",
          engineEvents: [],
        };
      }

      const totalCards = Object.keys(state.allCards).length;
      if (totalCards !== 52) {
        return {
          valid: false,
          reason: "Golf uses a standard 52-card deck.",
          engineEvents: [],
        };
      }

      const nextDealNumber = rulesState.dealNumber + 1;
      const dealerIndex = rulesState.dealerIndex % Math.max(players.length, 1);
      const dealerId = players[dealerIndex] ?? players[0];
      const firstPlayer = getNextPlayer(dealerId, players);
      const nextDealerIndex = (dealerIndex + 1) % players.length;

      engineEvents.push(
        ...gatherAllCards(state, { previousEvents: engineEvents })
      );

      const projected = projectPilesAfterEvents(state, engineEvents);
      const deckCardIds = projected["deck"]?.cardIds ?? [];
      if (deckCardIds.length < players.length * 4 + 1) {
        return {
          valid: false,
          reason: "Not enough cards to deal.",
          engineEvents: [],
        };
      }

      const deckSet = new Set(deckCardIds);
      const shuffled = shuffleAllCards(state, nextDealNumber, "GOLF", {
        useCurrentDeckIfFull: false,
      });

      const popNext = () => {
        for (let i = shuffled.length - 1; i >= 0; i--) {
          const cardId = shuffled[i];
          if (deckSet.has(cardId)) {
            deckSet.delete(cardId);
            return cardId;
          }
        }
        return null;
      };

      const dealOrder = rotatePlayers(players, dealerIndex + 1);
      for (const position of DEAL_POSITIONS) {
        for (const playerId of dealOrder) {
          const cardId = popNext();
          if (!cardId) {
            return {
              valid: false,
              reason: "Unexpected empty deck during deal.",
              engineEvents: [],
            };
          }
          engineEvents.push({
            type: "move-cards",
            fromPileId: "deck",
            toPileId: `${playerId}-${position}`,
            cardIds: [cardId],
          });
        }
      }

      const discardId = popNext();
      if (!discardId) {
        return {
          valid: false,
          reason: "No card available for the initial discard.",
          engineEvents: [],
        };
      }
      engineEvents.push({
        type: "move-cards",
        fromPileId: "deck",
        toPileId: "discard",
        cardIds: [discardId],
      });

      for (const playerId of players) {
        engineEvents.push(
          {
            type: "set-pile-visibility",
            pileId: `${playerId}-near-left`,
            visibility: "owner",
          },
          {
            type: "set-pile-visibility",
            pileId: `${playerId}-near-right`,
            visibility: "owner",
          },
          {
            type: "set-pile-visibility",
            pileId: `${playerId}-far-left`,
            visibility: "hidden",
          },
          {
            type: "set-pile-visibility",
            pileId: `${playerId}-far-right`,
            visibility: "hidden",
          }
        );
      }

      nextRulesState = {
        ...nextRulesState,
        hasDealt: true,
        dealNumber: nextDealNumber,
        dealerIndex: nextDealerIndex,
        phase: "peek",
        firstPlayer,
        turnPhase: "turn",
        drawnFrom: null,
        knockedBy: null,
        finalTurnsRemaining: 0,
        peekReady: Object.fromEntries(players.map((p) => [p, false])),
      };

      engineEvents.push({ type: "set-current-player", player: firstPlayer });
      engineEvents.push({
        type: "set-rules-state",
        rulesState: nextRulesState,
      });

      engineEvents.push({
        type: "set-actions",
        actions: deriveActions(state, nextRulesState, firstPlayer),
      });
      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: buildScoreboards(nextRulesState),
      });
      return { valid: true, engineEvents };
    }

    if (rulesState.phase === "peek") {
      if (intent.type !== "action" || intent.action !== "ready") {
        return {
          valid: false,
          reason: "Look at your two nearest cards, then click Ready.",
          engineEvents: [],
        };
      }

      if (state.currentPlayer && state.currentPlayer !== intent.playerId) {
        return {
          valid: false,
          reason: "It is not your turn to confirm.",
          engineEvents: [],
        };
      }

      if (rulesState.peekReady[intent.playerId ?? ""] === true) {
        return {
          valid: false,
          reason: "You are already ready.",
          engineEvents: [],
        };
      }

      const nextReady = {
        ...rulesState.peekReady,
        [intent.playerId]: true,
      };

      engineEvents.push(
        {
          type: "set-pile-visibility",
          pileId: `${intent.playerId}-near-left`,
          visibility: "hidden",
        },
        {
          type: "set-pile-visibility",
          pileId: `${intent.playerId}-near-right`,
          visibility: "hidden",
        }
      );

      nextRulesState = {
        ...nextRulesState,
        peekReady: nextReady,
      };

      const allReady = players.every((playerId) => nextReady[playerId]);
      let nextCurrentPlayer: string | null = null;
      if (allReady) {
        nextCurrentPlayer = nextRulesState.firstPlayer ?? players[0] ?? null;
        nextRulesState = {
          ...nextRulesState,
          phase: "play",
          turnPhase: "turn",
          drawnFrom: null,
          knockedBy: null,
          finalTurnsRemaining: 0,
        };
        engineEvents.push({
          type: "set-current-player",
          player: nextCurrentPlayer,
        });
      } else {
        const startFrom = intent.playerId ?? players[0] ?? null;
        if (startFrom) {
          let candidate = getNextPlayer(startFrom, players);
          for (let i = 0; i < players.length; i++) {
            if (!nextReady[candidate]) break;
            candidate = getNextPlayer(candidate, players);
          }
          nextCurrentPlayer = candidate;
        }
        engineEvents.push({
          type: "set-current-player",
          player: nextCurrentPlayer,
        });
      }

      engineEvents.push({
        type: "set-rules-state",
        rulesState: nextRulesState,
      });

      engineEvents.push({
        type: "set-actions",
        actions: deriveActions(state, nextRulesState, nextCurrentPlayer),
      });
      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: buildScoreboards(nextRulesState),
      });
      return { valid: true, engineEvents };
    }

    if (rulesState.phase !== "play") {
      return {
        valid: false,
        reason: "The hand has not started.",
        engineEvents: [],
      };
    }

    if (!state.currentPlayer || state.currentPlayer !== intent.playerId) {
      return {
        valid: false,
        reason: "It is not your turn.",
        engineEvents: [],
      };
    }

    const currentPlayer = state.currentPlayer;

    if (intent.type === "action") {
      let nextPlayerForActions: string | null = currentPlayer;
      if (rulesState.turnPhase !== "turn") {
        return {
          valid: false,
          reason: "You must resolve your drawn card.",
          engineEvents: [],
        };
      }

      if (intent.action === "knock") {
        if (rulesState.knockedBy !== null) {
          return {
            valid: false,
            reason: "A player has already knocked.",
            engineEvents: [],
          };
        }
        const nextPlayer = getNextPlayer(currentPlayer, players);
        nextPlayerForActions = nextPlayer;
        nextRulesState = {
          ...nextRulesState,
          knockedBy: currentPlayer,
          finalTurnsRemaining: players.length - 1,
          turnPhase: "turn",
          drawnFrom: null,
        };
        engineEvents.push({ type: "set-current-player", player: nextPlayer });
      } else {
        return {
          valid: false,
          reason: "Unknown action.",
          engineEvents: [],
        };
      }

      engineEvents.push({
        type: "set-rules-state",
        rulesState: nextRulesState,
      });

      engineEvents.push({
        type: "set-actions",
        actions: deriveActions(state, nextRulesState, nextPlayerForActions),
      });
      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: buildScoreboards(nextRulesState),
      });
      return { valid: true, engineEvents };
    }

    if (intent.type !== "move") {
      return {
        valid: false,
        reason: "Invalid intent.",
        engineEvents: [],
      };
    }

    const drawPile = drawPileId(currentPlayer);
    if (rulesState.turnPhase === "turn") {
      const drawPileSize = state.piles[drawPile]?.size ?? 0;
      if (drawPileSize > 0) {
        return {
          valid: false,
          reason: "You already have a drawn card.",
          engineEvents: [],
        };
      }

      if (intent.fromPileId === "deck" && intent.toPileId === drawPile) {
        const movedCardIds =
          intent.cardId !== undefined
            ? [intent.cardId]
            : (intent.cardIds ?? []);
        if (movedCardIds.length !== 1) {
          return {
            valid: false,
            reason: "You can only draw one stock card.",
            engineEvents: [],
          };
        }

        const topDeckId = getTopDeckCardId(state);
        if (!topDeckId) {
          return {
            valid: false,
            reason: "The stock is empty.",
            engineEvents: [],
          };
        }

        if (movedCardIds[0] !== topDeckId) {
          return {
            valid: false,
            reason: "You must draw the top stock card.",
            engineEvents: [],
          };
        }

        engineEvents.push({
          type: "move-cards",
          fromPileId: "deck",
          toPileId: drawPile,
          cardIds: movedCardIds as [number],
        });
        nextRulesState = {
          ...nextRulesState,
          turnPhase: "drawn",
          drawnFrom: "stock",
        };

        engineEvents.push({
          type: "set-rules-state",
          rulesState: nextRulesState,
        });

        engineEvents.push({
          type: "set-actions",
          actions: deriveActions(state, nextRulesState, state.currentPlayer),
        });
        engineEvents.push({
          type: "set-scoreboards",
          scoreboards: buildScoreboards(nextRulesState),
        });
        return { valid: true, engineEvents };
      }

      if (intent.fromPileId === "discard" && intent.toPileId === drawPile) {
        const movedCardIds =
          intent.cardId !== undefined
            ? [intent.cardId]
            : (intent.cardIds ?? []);
        if (movedCardIds.length !== 1) {
          return {
            valid: false,
            reason: "You can only draw one discard card.",
            engineEvents: [],
          };
        }

        const topDiscardId = getTopDiscardCardId(state);
        if (!topDiscardId || movedCardIds[0] !== topDiscardId) {
          return {
            valid: false,
            reason: "You must take the top discard.",
            engineEvents: [],
          };
        }

        engineEvents.push({
          type: "move-cards",
          fromPileId: "discard",
          toPileId: drawPile,
          cardIds: movedCardIds as [number],
        });
        nextRulesState = {
          ...nextRulesState,
          turnPhase: "drawn",
          drawnFrom: "discard",
        };

        engineEvents.push({
          type: "set-rules-state",
          rulesState: nextRulesState,
        });

        engineEvents.push({
          type: "set-actions",
          actions: deriveActions(state, nextRulesState, state.currentPlayer),
        });
        engineEvents.push({
          type: "set-scoreboards",
          scoreboards: buildScoreboards(nextRulesState),
        });
        return { valid: true, engineEvents };
      }

      return {
        valid: false,
        reason: "You must draw from the stock or take the top discard.",
        engineEvents: [],
      };
    }

    if (rulesState.turnPhase !== "drawn") {
      return {
        valid: false,
        reason: "You must draw before replacing or discarding.",
        engineEvents: [],
      };
    }

    if (intent.fromPileId !== drawPile) {
      return {
        valid: false,
        reason: "You must play the drawn card.",
        engineEvents: [],
      };
    }

    const movedCardIds =
      intent.cardId !== undefined ? [intent.cardId] : (intent.cardIds ?? []);
    if (movedCardIds.length !== 1) {
      return {
        valid: false,
        reason: "You can only move one drawn card.",
        engineEvents: [],
      };
    }

    const targetPile = intent.toPileId;
    const playerLayouts = new Set(layoutPileIds(currentPlayer));

    if (targetPile === "discard") {
      if (rulesState.drawnFrom !== "stock") {
        return {
          valid: false,
          reason: "You must replace a layout card when taking the discard.",
          engineEvents: [],
        };
      }
      engineEvents.push({
        type: "move-cards",
        fromPileId: drawPile,
        toPileId: "discard",
        cardIds: movedCardIds as [number],
      });
    } else if (playerLayouts.has(targetPile)) {
      const replaced = state.piles[targetPile]?.cards?.[0];
      if (!replaced) {
        return {
          valid: false,
          reason: "No card to replace in that position.",
          engineEvents: [],
        };
      }

      engineEvents.push({
        type: "move-cards",
        fromPileId: drawPile,
        toPileId: targetPile,
        cardIds: movedCardIds as [number],
      });
      engineEvents.push({
        type: "move-cards",
        fromPileId: targetPile,
        toPileId: "discard",
        cardIds: [replaced.id],
      });
    } else {
      return {
        valid: false,
        reason: "Choose one of your layout positions.",
        engineEvents: [],
      };
    }

    const projectedAfterMove = projectPilesAfterEvents(state, engineEvents);
    let endHand = false;
    let nextPlayer: string | null = null;

    nextRulesState = {
      ...nextRulesState,
      turnPhase: "turn",
      drawnFrom: null,
    };

    if (rulesState.knockedBy) {
      const remaining = Math.max(0, rulesState.finalTurnsRemaining - 1);
      nextRulesState.finalTurnsRemaining = remaining;
      if (remaining <= 0) {
        endHand = true;
      } else {
        nextPlayer = getNextPlayer(currentPlayer, players);
      }
    } else {
      nextPlayer = getNextPlayer(currentPlayer, players);
    }

    if (endHand) {
      const handScores: Record<string, number> = {};
      for (const playerId of players) {
        handScores[playerId] = scoreLayout(projectedAfterMove, state, playerId);
      }

      const updatedScores: Record<string, number> = {
        ...nextRulesState.scores,
      };
      for (const playerId of players) {
        updatedScores[playerId] =
          (updatedScores[playerId] ?? 0) + (handScores[playerId] ?? 0);
      }

      nextRulesState = {
        ...nextRulesState,
        hasDealt: false,
        phase: "deal",
        firstPlayer: null,
        scores: updatedScores,
        lastHandScores: handScores,
        knockedBy: null,
        finalTurnsRemaining: 0,
        peekReady: Object.fromEntries(players.map((p) => [p, false])),
      };

      for (const playerId of players) {
        for (const pileId of layoutPileIds(playerId)) {
          engineEvents.push({
            type: "set-pile-visibility",
            pileId,
            visibility: "public",
          });
        }
      }

      engineEvents.push({ type: "set-current-player", player: null });

      if (nextRulesState.dealNumber >= MAX_DEALS) {
        const p1Score = updatedScores[players[0]] ?? 0;
        const p2Score = updatedScores[players[1]] ?? 0;
        let winner: string | null = null;
        if (p1Score < p2Score) winner = players[0];
        if (p2Score < p1Score) winner = players[1];
        engineEvents.push({ type: "set-winner", winner });
      }
    } else if (nextPlayer) {
      engineEvents.push({ type: "set-current-player", player: nextPlayer });
    }

    engineEvents.push({
      type: "set-rules-state",
      rulesState: nextRulesState,
    });

    engineEvents.push({
      type: "set-actions",
      actions: deriveActions(state, nextRulesState, nextPlayer),
    });
    engineEvents.push({
      type: "set-scoreboards",
      scoreboards: buildScoreboards(nextRulesState),
    });

    return { valid: true, engineEvents };
  },
};

export const golfPlugin: GamePlugin = {
  id: "golf",
  gameName: META.gameName,
  ruleModule: golfRules,
  description: META.description,
  validationHints: {
    sharedPileIds: [
      "deck",
      "P1-near-left",
      "P1-near-right",
      "P1-far-left",
      "P1-far-right",
      "P2-near-left",
      "P2-near-right",
      "P2-far-left",
      "P2-far-right",
      "P1-draw",
      "P2-draw",
    ],
  },
};
