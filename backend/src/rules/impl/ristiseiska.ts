import { GameRuleModule, GamePlugin, ValidationHints } from "../interface.js";
import { ValidationState } from "../../validation-state.js";
import {
  ActionGrid,
  ClientIntent,
  Scoreboard,
} from "../../../../shared/schemas.js";
import {
  ValidationResult,
  EngineEvent,
} from "../../../../shared/validation.js";
import { loadGameMeta } from "../meta.js";
import { createRandom, fisherYates, stringToSeed } from "../../util/random.js";
import { projectPilesAfterEvents, type ProjectedPiles } from "../util/piles.js";
import {
  gatherAllCards,
  shuffleAllCards,
  distributeRoundRobin,
} from "../util/dealing.js";

const META = loadGameMeta("ristiseiska");

type Suit = "clubs" | "diamonds" | "hearts" | "spades";

interface RistiseiskaRulesState {
  hasDealt: boolean;
  phase: "setup" | "playing" | "ended";
  starter: string | null;
  result: string | null;
}

const SUITS: Suit[] = ["clubs", "diamonds", "hearts", "spades"];
const RANK_ORDER: string[] = [
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
];

const PASS_ACTIONS: ActionGrid = {
  rows: 1,
  cols: 1,
  cells: [{ id: "pass", label: "Pass", enabled: true, row: 0, col: 0 }],
};

const EMPTY_ACTIONS: ActionGrid = { rows: 0, cols: 0, cells: [] };

function getSuitPileId(suit: string): string {
  return `${suit}-table`;
}

function getNextPlayer(state: ValidationState, playerId: string): string {
  const playerIds = state.players.map((p) => p.id);
  const idx = playerIds.indexOf(playerId);
  return playerIds[(idx + 1) % playerIds.length];
}

function buildScoreboard(
  state: ValidationState,
  projected: ProjectedPiles
): Scoreboard {
  const players = state.players;
  const rows = players.length + 1;
  const cols = 2;

  const cells: Scoreboard["cells"] = [
    { row: 0, col: 0, text: "Player", role: "header", align: "left" },
    { row: 0, col: 1, text: "Cards", role: "header", align: "right" },
  ];

  players.forEach((p, i: number) => {
    const handId = `${p.id}-hand`;
    const count = projected[handId]?.size ?? state.piles[handId]?.size ?? 0;
    cells.push({
      row: i + 1,
      col: 0,
      text: p.id,
      role: "header",
      align: "left",
    });
    cells.push({
      row: i + 1,
      col: 1,
      text: String(count),
      align: "right",
    });
  });

  return {
    id: "ristiseiska-counts",
    title: "Cards in hand",
    rows,
    cols,
    cells,
  };
}

function dealFromDeck(
  state: ValidationState,
  rulesState: RistiseiskaRulesState
): EngineEvent[] {
  const totalCards = Object.keys(state.allCards).length;
  if (totalCards !== 52) {
    throw new Error(
      `Ristiseiska: expected 52 cards in deck registry (found ${totalCards})`
    );
  }
  const engineEvents: EngineEvent[] = gatherAllCards(state);

  const shuffledCardIds = shuffleAllCards(state, 0, "RISTISEISKA");

  const playerIds = state.players.map((p) => p.id);
  const hands = playerIds.map((pid) => `${pid}-hand`);
  const cardsPerPlayer = Math.ceil(shuffledCardIds.length / hands.length);
  const { events: dealEvents } = distributeRoundRobin(
    shuffledCardIds,
    hands,
    cardsPerPlayer
  );
  engineEvents.push(...dealEvents);

  let starter: string | null = null;
  shuffledCardIds.forEach((cardId: number, idx: number) => {
    const card = state.allCards[cardId];
    if (card && card.suit === "clubs" && card.rank === "7") {
      starter = playerIds[idx % playerIds.length];
    }
  });

  engineEvents.push({
    type: "set-rules-state",
    rulesState: {
      ...rulesState,
      hasDealt: true,
      phase: "playing",
      starter,
      result: null,
    },
  });

  engineEvents.push(
    {
      type: "set-current-player",
      player: starter ?? "P1",
    },
    {
      type: "set-scoreboards",
      scoreboards: [
        buildScoreboard(state, projectPilesAfterEvents(state, engineEvents)),
      ],
    },
    {
      type: "set-actions",
      actions: PASS_ACTIONS,
    }
  );

  return engineEvents;
}

type SuitRanks = Record<Suit, Set<string>>;

function collectTableRanks(state: ValidationState): SuitRanks {
  const perSuit: SuitRanks = {
    clubs: new Set(),
    diamonds: new Set(),
    hearts: new Set(),
    spades: new Set(),
  };

  for (const suit of SUITS) {
    const pileId = getSuitPileId(suit);
    const pile = state.piles[pileId];
    if (!pile || !pile.cards) continue;
    for (const card of pile.cards) {
      perSuit[suit].add(card.rank);
    }
  }

  return perSuit;
}

function hasSevenOfClubsOnTable(tableRanks: SuitRanks): boolean {
  return tableRanks.clubs.has("7");
}

function isCardPlayable(
  card: { rank: string; suit: string },
  tableRanks: SuitRanks,
  clubsSevenPlayed: boolean
): boolean {
  const suit = card.suit as Suit;
  if (!SUITS.includes(suit)) return false;

  const ranksForSuit = tableRanks[suit];

  if (!clubsSevenPlayed) {
    return card.suit === "clubs" && card.rank === "7";
  }

  if (ranksForSuit.size === 0) {
    return card.rank === "7";
  }

  if (card.rank === "7") {
    return true;
  }

  if (!ranksForSuit.has("7")) {
    return false;
  }

  if (card.rank === "6") {
    return true;
  }

  if (card.rank === "8") {
    return ranksForSuit.has("6");
  }

  if (["5", "4", "3", "2"].includes(card.rank)) {
    const rankIndex = RANK_ORDER.indexOf(card.rank);
    const higherRank = RANK_ORDER[rankIndex + 1];
    return ranksForSuit.has(higherRank);
  }

  if (["9", "10", "J", "Q", "K"].includes(card.rank)) {
    const rankIndex = RANK_ORDER.indexOf(card.rank);
    const lowerRank = RANK_ORDER[rankIndex - 1];
    return ranksForSuit.has(lowerRank);
  }

  if (card.rank === "A") {
    return RANK_ORDER.slice(0, 12).every((r) => ranksForSuit.has(r));
  }

  return false;
}

function listPlayableMoveIntents(
  state: ValidationState,
  playerId: string
): ClientIntent[] {
  const intents: ClientIntent[] = [];
  const handPileId = `${playerId}-hand`;
  const handPile = state.piles[handPileId];
  if (!handPile || !handPile.cards) {
    return intents;
  }

  const tableRanks = collectTableRanks(state);
  const clubsSevenDown = hasSevenOfClubsOnTable(tableRanks);

  for (const card of handPile.cards) {
    if (isCardPlayable(card, tableRanks, clubsSevenDown)) {
      intents.push({
        type: "move",
        gameId: state.gameId,
        playerId,
        fromPileId: handPileId,
        toPileId: getSuitPileId(card.suit),
        cardId: card.id,
      });
    }
  }

  return intents;
}

export const ristiseiskaRules: GameRuleModule = {
  listLegalIntentsForPlayer(
    state: ValidationState,
    playerId: string
  ): ClientIntent[] {
    const intents: ClientIntent[] = [];
    const rawRulesState =
      (state.rulesState as Partial<RistiseiskaRulesState>) ?? {};
    const rulesState: RistiseiskaRulesState = {
      hasDealt: rawRulesState.hasDealt ?? false,
      phase: rawRulesState.phase ?? "setup",
      starter: rawRulesState.starter ?? null,
      result: rawRulesState.result ?? null,
    };

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

    if (
      state.winner ||
      !state.currentPlayer ||
      state.currentPlayer !== playerId
    ) {
      return intents;
    }

    const candidates: ClientIntent[] = [];
    candidates.push({ type: "action", gameId, playerId, action: "pass" });

    const handPileId = `${playerId}-hand`;
    const handPile = state.piles[handPileId];
    if (handPile && handPile.cards) {
      for (const card of handPile.cards) {
        candidates.push({
          type: "move",
          gameId,
          playerId,
          fromPileId: handPileId,
          toPileId: getSuitPileId(card.suit),
          cardId: card.id,
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
    const engineEvents: EngineEvent[] = [];
    const rawRulesState =
      (state.rulesState as Partial<RistiseiskaRulesState>) ?? {};
    const rulesState: RistiseiskaRulesState = {
      hasDealt: rawRulesState.hasDealt ?? false,
      phase: rawRulesState.phase ?? "setup",
      starter: rawRulesState.starter ?? null,
      result: rawRulesState.result ?? null,
    };

    if (!rulesState.hasDealt) {
      if (intent.type === "action" && intent.action === "start-game") {
        engineEvents.push(...dealFromDeck(state, rulesState));
        return { valid: true, reason: null, engineEvents };
      }
      return {
        valid: false,
        reason: "The game has not started yet. Use the 'Start Game' action.",
        engineEvents: [],
      };
    }

    if (state.winner) {
      return {
        valid: false,
        reason: "The game is already over.",
        engineEvents: [],
      };
    }

    if (!state.currentPlayer || state.currentPlayer !== intent.playerId) {
      return { valid: false, reason: "It is not your turn.", engineEvents: [] };
    }

    if (intent.type === "action") {
      if (intent.action !== "pass") {
        return { valid: false, reason: "Unknown action.", engineEvents: [] };
      }

      const availableMoves = listPlayableMoveIntents(state, intent.playerId);
      if (availableMoves.length > 0) {
        return {
          valid: false,
          reason: "You must play a card if you have a legal move.",
          engineEvents: [],
        };
      }

      engineEvents.push({
        type: "set-current-player",
        player: getNextPlayer(state, intent.playerId),
      });

      const nextId = getNextPlayer(state, intent.playerId);
      const nextHand = state.piles[`${nextId}-hand`];
      if (nextHand && nextHand.size > 0) {
        const tableCardIds = new Set<number>();
        for (const suit of SUITS) {
          const pile = state.piles[getSuitPileId(suit)];
          if (pile?.cards) {
            for (const c of pile.cards) tableCardIds.add(c.id);
          }
        }

        const myHandCardIds = new Set<number>();
        const myHand = state.piles[`${intent.playerId}-hand`];
        if (myHand?.cards) {
          for (const c of myHand.cards) myHandCardIds.add(c.id);
        }

        const otherCardIds: number[] = [];
        const allCardIds = Object.keys(state.allCards)
          .map(Number)
          .sort((a, b) => a - b);
        for (const cardId of allCardIds) {
          if (!tableCardIds.has(cardId) && !myHandCardIds.has(cardId)) {
            // Check if card belongs to next player's hand specifically
            const isNextPlayerCard = (
              state.piles[`${nextId}-hand`]?.cards ?? []
            ).some((c) => c.id === cardId);
            if (isNextPlayerCard) {
              otherCardIds.push(cardId);
            }
          }
        }

        if (otherCardIds.length > 0) {
          const baseSeed = stringToSeed(state.seed || "RISTISEISKA_PASS");
          const tableCardCount = SUITS.reduce(
            (sum, suit) => sum + (state.piles[getSuitPileId(suit)]?.size || 0),
            0
          );
          const random = createRandom(
            baseSeed + tableCardCount + nextHand.size
          );
          const shuffled = fisherYates(otherCardIds, random);
          const penaltyCardId = shuffled[0];

          engineEvents.push({
            type: "move-cards",
            fromPileId: `${nextId}-hand`,
            toPileId: `${intent.playerId}-hand`,
            cardIds: [penaltyCardId],
          });
        }
      }

      engineEvents.push({
        type: "set-scoreboards",
        scoreboards: [
          buildScoreboard(state, projectPilesAfterEvents(state, engineEvents)),
        ],
      });

      engineEvents.push({
        type: "set-actions",
        actions: PASS_ACTIONS,
      });

      engineEvents.push({
        type: "set-rules-state",
        rulesState: {
          ...rulesState,
        },
      });

      return { valid: true, reason: null, engineEvents };
    }

    if (intent.type !== "move") {
      return {
        valid: false,
        reason: "Only card moves are allowed.",
        engineEvents: [],
      };
    }

    const fromPile = state.piles[intent.fromPileId];
    const toPile = state.piles[intent.toPileId];
    if (!fromPile || !fromPile.cards || fromPile.ownerId !== intent.playerId) {
      return {
        valid: false,
        reason: "You must play cards from your own hand.",
        engineEvents: [],
      };
    }
    if (!toPile || !SUITS.includes(toPile.id.replace("-table", "") as Suit)) {
      return {
        valid: false,
        reason:
          "Invalid destination pile. Play to the suit piles on the table.",
        engineEvents: [],
      };
    }

    // Engine guarantees card exists in source pile
    const movedCard = fromPile.cards.find((card) => card.id === intent.cardId)!;

    const tableRanks = collectTableRanks(state);
    const clubsSevenDown = hasSevenOfClubsOnTable(tableRanks);
    if (!isCardPlayable(movedCard, tableRanks, clubsSevenDown)) {
      return {
        valid: false,
        reason:
          "This card cannot be played yet. You must play a 7 or extend an existing sequence.",
        engineEvents: [],
      };
    }

    if (getSuitPileId(movedCard.suit) !== intent.toPileId) {
      return {
        valid: false,
        reason: "You must play the card to its corresponding suit pile.",
        engineEvents: [],
      };
    }

    engineEvents.push({
      type: "move-cards",
      fromPileId: intent.fromPileId,
      toPileId: intent.toPileId,
      cardIds: [movedCard.id],
    });

    const projected = projectPilesAfterEvents(state, engineEvents);
    const nextHand = projected[`${intent.playerId}-hand`];
    const isWin = nextHand && nextHand.size === 0;
    if (nextHand && nextHand.size === 0) {
      engineEvents.push({
        type: "announce",
        text: `${intent.playerId} played the last card!`,
        anchor: { type: "screen" },
      });
      engineEvents.push({
        type: "set-winner",
        winner: intent.playerId,
      });
      engineEvents.push({
        type: "set-rules-state",
        rulesState: {
          ...rulesState,
          phase: "ended",
          result: intent.playerId,
        },
      });
      engineEvents.push({
        type: "set-current-player",
        player: null,
      });
    } else {
      engineEvents.push({
        type: "set-current-player",
        player: getNextPlayer(state, intent.playerId),
      });
      engineEvents.push({
        type: "set-rules-state",
        rulesState: {
          ...rulesState,
          phase: "playing",
        },
      });
    }

    engineEvents.push({
      type: "set-scoreboards",
      scoreboards: [buildScoreboard(state, projected)],
    });

    engineEvents.push({
      type: "set-actions",
      actions: isWin ? EMPTY_ACTIONS : PASS_ACTIONS,
    });

    return { valid: true, reason: null, engineEvents };
  },
};

export const ristiseiskaPlugin: GamePlugin = {
  id: "ristiseiska",
  gameName: META.gameName,
  ruleModule: ristiseiskaRules,
  description: META.description,
  validationHints: (() => {
    const hints: ValidationHints = {
      sharedPileIds: [
        "deck",
        "clubs-table",
        "diamonds-table",
        "hearts-table",
        "spades-table",
      ],
      isPileAlwaysVisibleToRules: (pid) => pid.endsWith("-hand"),
    };
    return hints;
  })(),
};
