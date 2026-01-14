/**
 * Canonical Podkidnoy Durak game rules (deterministic TypeScript implementation).
 *
 * Podkidnoy Durak uses a 36-card deck (ranks 6-Ace).
 * Rules based on https://www.pagat.com/beating/podkidnoy_durak.html
 */
import type {
  GameRuleModule,
  GamePlugin,
  ValidationHints,
} from "../interface.js";
import type { ValidationState } from "../../validation-state.js";
import type {
  ClientIntent,
  Scoreboard,
  ScoreboardCell,
} from "../../../../shared/schemas.js";
import type {
  ValidationResult,
  EngineEvent,
} from "../../../../shared/validation.js";
import { loadGameMeta } from "../meta.js";
import { getSuitSymbol, formatCard } from "../../util/card-notation.js";
import { projectPilesAfterEvents } from "../util/piles.js";
import { gatherAllCards, distributeRoundRobin } from "../util/dealing.js";

const META = loadGameMeta("durak");

interface DurakRulesState {
  hasDealt: boolean;
  trumpSuit: string | null;
  attackerId: string | null;
  defenderId: string | null;
  result: string | null;
  // Bout tracks cards played in the current bout
  bout: Array<{
    attackCardId: number;
    attackRank: string;
    attackSuit: string;
    defenseCardId: number | null;
    defenseRank?: string;
    defenseSuit?: string;
  }>;
}

const RANK_MAP: Record<string, number> = {
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

function getRank(rankStr: string): number {
  return RANK_MAP[rankStr] || 0;
}

function getOtherPlayer(current: string): string {
  return current === "P1" ? "P2" : "P1";
}

function deriveActions(rulesState: DurakRulesState, playerId: string | null) {
  if (!rulesState.hasDealt || !playerId) return { rows: 0, cols: 0, cells: [] };

  const cells = [];
  if (rulesState.attackerId === playerId) {
    const canDone =
      rulesState.bout.length > 0 &&
      rulesState.bout.every((b) => b.defenseCardId !== null);
    cells.push({
      id: "done",
      label: "Done",
      enabled: canDone,
      row: 0,
      col: 0,
    });
  } else if (rulesState.defenderId === playerId) {
    const canTake = rulesState.bout.some((b) => b.defenseCardId === null);
    cells.push({
      id: "take",
      label: "Take Cards",
      enabled: canTake,
      row: 0,
      col: 0,
    });
  }

  return { rows: 1, cols: 1, cells };
}

function buildScoreboard(
  state: ValidationState,
  projected: Record<string, { size: number }>,
  rulesState: DurakRulesState
): Scoreboard {
  const p1Count =
    projected["P1-hand"]?.size ?? state.piles["P1-hand"]?.size ?? 0;
  const p2Count =
    projected["P2-hand"]?.size ?? state.piles["P2-hand"]?.size ?? 0;
  const deckCount = projected["deck"]?.size ?? state.piles["deck"]?.size ?? 0;
  const trumpPileCount =
    projected["trump-card"]?.size ?? state.piles["trump-card"]?.size ?? 0;
  const totalStock = deckCount + trumpPileCount;

  const trumpText = rulesState.trumpSuit
    ? getSuitSymbol(rulesState.trumpSuit)
    : "None";

  const cells: ScoreboardCell[] = [
    { row: 0, col: 0, text: "Item", role: "header", align: "left" },
    { row: 0, col: 1, text: "Value", role: "header", align: "right" },
    { row: 1, col: 0, text: "Trump", role: "body", align: "left" },
    { row: 1, col: 1, text: trumpText, align: "right" },
    { row: 2, col: 0, text: "Attacker", role: "body", align: "left" },
    { row: 2, col: 1, text: rulesState.attackerId || "None", align: "right" },
    { row: 3, col: 0, text: "Defender", role: "body", align: "left" },
    { row: 3, col: 1, text: rulesState.defenderId || "None", align: "right" },
    { row: 4, col: 0, text: "P1 Hand", role: "body", align: "left" },
    { row: 4, col: 1, text: String(p1Count), align: "right" },
    { row: 5, col: 0, text: "P2 Hand", role: "body", align: "left" },
    { row: 5, col: 1, text: String(p2Count), align: "right" },
    { row: 6, col: 0, text: "Deck", role: "body", align: "left" },
    { row: 6, col: 1, text: String(totalStock), align: "right" },
  ];

  return {
    id: "durak-main",
    title: "Game Status",
    rows: 7,
    cols: 2,
    cells,
  };
}

function canBeatCard(
  attack: { rank: string; suit: string },
  defend: { rank: string; suit: string },
  trumpSuit: string
): boolean {
  if (defend.suit === attack.suit) {
    return getRank(defend.rank) > getRank(attack.rank);
  }
  return defend.suit === trumpSuit;
}

function dealFromDeck(state: ValidationState): EngineEvent[] {
  const totalCards = Object.keys(state.allCards).length;
  if (totalCards !== 36) {
    throw new Error(
      `Durak: expected 36 cards in deck registry (found ${totalCards})`
    );
  }
  const deck = state.piles["deck"];
  if (!deck?.cards || deck.cards.length !== totalCards) {
    throw new Error(
      `Durak: deck must expose all ${totalCards} cards before dealing`
    );
  }
  const deckCardIds = deck.cards.map((c) => c.id);
  const engineEvents: EngineEvent[] = gatherAllCards(state);

  const { events: dealEvents } = distributeRoundRobin(
    deckCardIds,
    ["P1-hand", "P2-hand"],
    6
  );
  engineEvents.push(...dealEvents);

  const trumpCardId = deckCardIds[deckCardIds.length - 1];
  const trumpCard = state.allCards[trumpCardId];
  const trumpSuit = trumpCard.suit;

  engineEvents.push({
    type: "move-cards",
    fromPileId: "deck",
    toPileId: "trump-card",
    cardIds: [trumpCardId],
  });

  const p1Hand = deckCardIds
    .slice(0, 12)
    .filter((_, i) => i % 2 === 0)
    .map((id) => state.allCards[id]);
  const p2Hand = deckCardIds
    .slice(0, 12)
    .filter((_, i) => i % 2 !== 0)
    .map((id) => state.allCards[id]);

  const getLowestTrump = (hand: { rank: string; suit: string }[]) => {
    const trumps = hand
      .filter((c) => c.suit === trumpSuit)
      .map((c) => getRank(c.rank));
    return trumps.length > 0 ? Math.min(...trumps) : 999;
  };

  const p1Lowest = getLowestTrump(p1Hand);
  const p2Lowest = getLowestTrump(p2Hand);

  const attackerId = p1Lowest <= p2Lowest ? "P1" : "P2";

  const nextRulesState: DurakRulesState = {
    hasDealt: true,
    trumpSuit,
    attackerId,
    defenderId: getOtherPlayer(attackerId),
    result: null,
    bout: [],
  };

  engineEvents.push({ type: "set-rules-state", rulesState: nextRulesState });
  engineEvents.push({ type: "set-current-player", player: attackerId });

  const projected = projectPilesAfterEvents(state, engineEvents);
  engineEvents.push({
    type: "set-scoreboards",
    scoreboards: [buildScoreboard(state, projected, nextRulesState)],
  });
  engineEvents.push({
    type: "set-actions",
    actions: deriveActions(nextRulesState, attackerId),
  });

  return engineEvents;
}

function drawCards(
  state: ValidationState,
  attackerId: string,
  defenderId: string,
  attackerHandSize: number,
  defenderHandSize: number
): EngineEvent[] {
  const events: EngineEvent[] = [];
  const deck = state.piles["deck"];
  const trumpPile = state.piles["trump-card"];

  const deckCards = deck?.cards?.map((c) => c.id) || [];
  const trumpCards = trumpPile?.cards?.map((c) => c.id) || [];
  const allStockCards = [...deckCards, ...trumpCards];

  if (allStockCards.length === 0) return [];

  const players = [attackerId, defenderId];
  const handSizes = {
    [attackerId]: attackerHandSize,
    [defenderId]: defenderHandSize,
  };
  let stockIndex = 0;

  for (const pid of players) {
    const handId = `${pid}-hand`;
    const currentSize = handSizes[pid];
    const toDraw = Math.max(0, 6 - currentSize);

    for (let i = 0; i < toDraw && stockIndex < allStockCards.length; i++) {
      const cardId = allStockCards[stockIndex++];
      const fromPileId = deckCards.includes(cardId) ? "deck" : "trump-card";
      events.push({
        type: "move-cards",
        fromPileId,
        toPileId: handId,
        cardIds: [cardId],
      });
    }
  }

  return events;
}

export const durakRules: GameRuleModule = {
  listLegalIntentsForPlayer(
    state: ValidationState,
    playerId: string
  ): ClientIntent[] {
    const intents: ClientIntent[] = [];
    const rulesState = state.rulesState as DurakRulesState;
    const gameId = state.gameId;

    if (!rulesState?.hasDealt) {
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

    if (state.winner || state.currentPlayer !== playerId) return intents;

    const hand = state.piles[`${playerId}-hand`];
    if (!hand || !hand.cards) return intents;

    const candidates: ClientIntent[] = [];

    candidates.push({ type: "action", gameId, playerId, action: "done" });
    candidates.push({ type: "action", gameId, playerId, action: "take" });

    for (const card of hand.cards) {
      candidates.push({
        type: "move",
        gameId,
        playerId,
        fromPileId: `${playerId}-hand`,
        toPileId: "table",
        cardId: card.id,
      });
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
    const rulesState = state.rulesState as DurakRulesState;

    if (!rulesState?.hasDealt) {
      if (intent.type === "action" && intent.action === "start-game") {
        return { valid: true, engineEvents: dealFromDeck(state) };
      }
      return {
        valid: false,
        reason: "The game has not started yet. Use the 'Start Game' action.",
        engineEvents: [],
      };
    }

    if (state.winner)
      return {
        valid: false,
        reason: "The game is already over.",
        engineEvents: [],
      };
    if (state.currentPlayer !== intent.playerId)
      return { valid: false, reason: "It is not your turn.", engineEvents: [] };

    const attackerId = rulesState.attackerId!;
    const defenderId = rulesState.defenderId!;
    const isAttacker = intent.playerId === attackerId;
    const isDefender = intent.playerId === defenderId;

    const nextRulesState = { ...rulesState };
    let nextPlayer = state.currentPlayer;

    if (intent.type === "move") {
      const fromPile = state.piles[intent.fromPileId];
      // Engine guarantees card exists in source pile
      const card = fromPile.cards!.find((c) => c.id === intent.cardId)!;

      if (isAttacker) {
        if (nextRulesState.bout.some((b) => b.defenseCardId === null)) {
          return {
            valid: false,
            reason: "You must wait for the defender to beat your last card.",
            engineEvents: [],
          };
        }
        if (nextRulesState.bout.length > 0) {
          const ranksOnTable = new Set<string>();
          nextRulesState.bout.forEach((b) => {
            ranksOnTable.add(b.attackRank);
            if (b.defenseRank) ranksOnTable.add(b.defenseRank);
          });
          if (!ranksOnTable.has(card.rank)) {
            const ranks = Array.from(ranksOnTable).join(", ");
            return {
              valid: false,
              reason: `You are the attacker. You can only play cards with ranks already on the table (${ranks}), or click 'Done' to end the bout.`,
              engineEvents: [],
            };
          }
        }
        if (nextRulesState.bout.length >= 6) {
          return {
            valid: false,
            reason: "Maximum of 6 attacks per bout reached.",
            engineEvents: [],
          };
        }
        const defenderHandSize = state.piles[`${defenderId}-hand`].size;
        if (nextRulesState.bout.length >= defenderHandSize) {
          return {
            valid: false,
            reason:
              "You cannot attack with more cards than the defender has in their hand.",
            engineEvents: [],
          };
        }

        engineEvents.push({
          type: "move-cards",
          fromPileId: intent.fromPileId,
          toPileId: "table",
          cardIds: [card.id],
        });
        nextRulesState.bout = [
          ...nextRulesState.bout,
          {
            attackCardId: card.id,
            attackRank: card.rank,
            attackSuit: card.suit,
            defenseCardId: null,
          },
        ];
        nextPlayer = defenderId;
      } else if (isDefender) {
        const activeAttack = nextRulesState.bout.find(
          (b) => b.defenseCardId === null
        );
        if (!activeAttack)
          return {
            valid: false,
            reason: "There is no attack card to delete against.",
            engineEvents: [],
          };

        if (
          !canBeatCard(
            { rank: activeAttack.attackRank, suit: activeAttack.attackSuit },
            { rank: card.rank, suit: card.suit },
            nextRulesState.trumpSuit!
          )
        ) {
          return {
            valid: false,
            reason: `This card cannot beat the ${formatCard(activeAttack.attackRank, activeAttack.attackSuit)}. You must play a higher card of the same suit or a trump card (${getSuitSymbol(nextRulesState.trumpSuit!)}).`,
            engineEvents: [],
          };
        }

        engineEvents.push({
          type: "move-cards",
          fromPileId: intent.fromPileId,
          toPileId: "table",
          cardIds: [card.id],
        });
        nextRulesState.bout = nextRulesState.bout.map((b) =>
          b.attackCardId === activeAttack.attackCardId
            ? {
                ...b,
                defenseCardId: card.id,
                defenseRank: card.rank,
                defenseSuit: card.suit,
              }
            : b
        );
        nextPlayer = attackerId;
      }
    } else if (intent.type === "action") {
      if (intent.action === "done" && isAttacker) {
        if (
          nextRulesState.bout.length === 0 ||
          nextRulesState.bout.some((b) => b.defenseCardId === null)
        ) {
          return {
            valid: false,
            reason:
              "You cannot end the bout until all attack cards are defended.",
            engineEvents: [],
          };
        }
        const tableCardIds = state.piles["table"].cards!.map((c) => c.id);
        engineEvents.push({
          type: "move-cards",
          fromPileId: "table",
          toPileId: "discard",
          cardIds: tableCardIds as [number, ...number[]],
        });

        engineEvents.push(
          ...drawCards(
            state,
            attackerId,
            defenderId,
            state.piles[`${attackerId}-hand`].size,
            state.piles[`${defenderId}-hand`].size
          )
        );

        const newAttacker = defenderId;
        nextRulesState.attackerId = newAttacker;
        nextRulesState.defenderId = getOtherPlayer(newAttacker);
        nextRulesState.bout = [];
        nextPlayer = newAttacker;
      } else if (intent.action === "take" && isDefender) {
        const tableCardIds = state.piles["table"].cards!.map((c) => c.id);
        engineEvents.push({
          type: "move-cards",
          fromPileId: "table",
          toPileId: `${defenderId}-hand`,
          cardIds: tableCardIds as [number, ...number[]],
        });

        const defenderNewSize =
          state.piles[`${defenderId}-hand`].size + tableCardIds.length;
        engineEvents.push(
          ...drawCards(
            state,
            attackerId,
            defenderId,
            state.piles[`${attackerId}-hand`].size,
            defenderNewSize
          )
        );

        nextRulesState.bout = [];
        nextPlayer = attackerId;
      } else {
        const guidance = isAttacker
          ? "As the attacker, you can play cards with matching ranks or click 'Done' to end the bout."
          : "As the defender, you must beat attacking cards or click 'Take' to pick up all cards.";
        return { valid: false, reason: guidance, engineEvents: [] };
      }
    }

    engineEvents.push({ type: "set-rules-state", rulesState: nextRulesState });
    engineEvents.push({ type: "set-current-player", player: nextPlayer || "" });
    engineEvents.push({
      type: "set-actions",
      actions: deriveActions(nextRulesState, nextPlayer),
    });

    const finalProjected = projectPilesAfterEvents(state, engineEvents);
    const deckSize = finalProjected["deck"].size;
    const trumpSize = finalProjected["trump-card"].size;
    const p1HandSize = finalProjected["P1-hand"].size;
    const p2HandSize = finalProjected["P2-hand"].size;

    if (deckSize === 0 && trumpSize === 0) {
      if (p1HandSize === 0 && p2HandSize > 0)
        engineEvents.push({ type: "set-winner", winner: "P1" });
      else if (p2HandSize === 0 && p1HandSize > 0)
        engineEvents.push({ type: "set-winner", winner: "P2" });
      else if (p1HandSize === 0 && p2HandSize === 0)
        engineEvents.push({ type: "set-winner", winner: "DRAW" });
    }

    engineEvents.push({
      type: "set-scoreboards",
      scoreboards: [buildScoreboard(state, finalProjected, nextRulesState)],
    });
    return { valid: true, engineEvents };
  },
};

export const durakPlugin: GamePlugin = {
  id: "durak",
  gameName: META.gameName,
  ruleModule: durakRules,
  description: META.description,
  validationHints: {
    sharedPileIds: ["table", "deck", "trump-card", "discard"],
  } satisfies ValidationHints,
};
