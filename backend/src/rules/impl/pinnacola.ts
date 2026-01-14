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

type PinnacolaPhase = "dealing" | "playing" | "ended";
type TurnPhase =
  | "must-draw"
  | "play-or-discard"
  | "must-meld-pozzo-top"
  | "must-reuse-joker";

/** Returns a user-friendly explanation of what moves are allowed in the current turn phase. */
function getTurnPhaseGuidance(turnPhase: TurnPhase): string {
  switch (turnPhase) {
    case "must-draw":
      return "You must draw a card from the deck or take from the pozzo (discard pile).";
    case "play-or-discard":
      return "You may play cards to your melds. When ready, discard a card to end your turn.";
    case "must-meld-pozzo-top":
      return "You took the pozzo—now you must meld the top card before continuing.";
    case "must-reuse-joker":
      return "You replaced a joker from a meld—now you must use that joker in another meld.";
  }
}

interface PinnacolaRulesState {
  phase: PinnacolaPhase;
  hasDealt: boolean;
  dealNumber: number;
  players: string[];
  turnPhase: TurnPhase;
  turnPlayerId: string;
  cardsPlayedToMeldsThisTurn: number[];
  mandatoryMeldCardId: number | null;
  cumulativeScores: Record<string, number>;
  playersWhoDiscarded: string[]; // Track who has discarded this hand
  result: string | null;
}

type SimpleCard = { id: number; rank: string; suit: string };

const CARD_VALUES: Record<string, number> = {
  A: 15,
  "2": 5,
  "3": 5,
  "4": 5,
  "5": 5,
  "6": 10,
  "7": 10,
  "8": 10,
  "9": 10,
  "10": 10,
  J: 10,
  Q: 10,
  K: 10,
  JOKER: 25,
};

function isWild(card: SimpleCard): boolean {
  return card.rank === "JOKER";
}

function getCardPoints(card: SimpleCard): number {
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

// -------- Helpers --------

function getPinnacolaRulesState(
  raw: unknown,
  players: string[]
): PinnacolaRulesState {
  const validPlayers = players && players.length > 0 ? players : ["P1", "P2"];
  const base: PinnacolaRulesState = {
    phase: "dealing",
    hasDealt: false,
    dealNumber: 0,
    players: validPlayers,
    turnPhase: "must-draw",
    turnPlayerId: validPlayers[0],
    cardsPlayedToMeldsThisTurn: [],
    mandatoryMeldCardId: null,
    cumulativeScores: { [validPlayers[0]]: 0, [validPlayers[1] || "P2"]: 0 },
    playersWhoDiscarded: [],
    result: null,
  };

  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Partial<PinnacolaRulesState>;

  return {
    ...base,
    ...obj,
    cumulativeScores: obj.cumulativeScores ?? base.cumulativeScores,
  };
}

function getOtherPlayer(current: string, players: string[]): string {
  const idx = players.indexOf(current);
  return players[(idx + 1) % players.length];
}

function meldPileIdsForPlayer(playerId: string): string[] {
  return Array.from(
    { length: MELD_SLOT_COUNT },
    (_, i) => `${playerId}-meld-${i}`
  );
}

function validateMeld(cards: SimpleCard[]): {
  valid: boolean;
  type?: "set" | "run";
  points?: number;
  isPinnacola?: boolean;
  isPinnacolone?: boolean;
  isPoker?: boolean;
} {
  if (cards.length < 3) return { valid: false };

  const wildcards = cards.filter(isWild);
  const naturals = cards.filter((c) => !isWild(c));

  // Special case: Poker of Jokers
  if (naturals.length === 0) {
    if (wildcards.length === 4) {
      return { valid: true, type: "set", points: 600, isPoker: true };
    }
    // Allow 2 or 3 jokers as a temporary valid state towards a Poker of Jokers
    if (wildcards.length >= 2 && wildcards.length <= 3) {
      return { valid: true, type: "set", points: 0 };
    }
  }

  if (wildcards.length > 1) return { valid: false };

  // Set (Tris or Poker)
  const firstRank = naturals[0].rank;
  const isSet = naturals.every((c) => c.rank === firstRank);
  if (isSet) {
    const suits = new Set(naturals.map((c) => c.suit));
    if (suits.size !== naturals.length) return { valid: false };

    let points = cards.reduce((sum, c) => sum + getCardPoints(c), 0);
    const isPoker = cards.length === 4 && wildcards.length === 0;
    if (isPoker) {
      if (firstRank === "A") points = 120;
      else if (["K", "Q", "J", "10", "9", "8", "7", "6"].includes(firstRank))
        points = 80;
      else points = 40;
    }
    return { valid: true, type: "set", points, isPoker };
  }

  // Run (Scala)
  const firstSuit = naturals[0].suit;
  if (!naturals.every((c) => c.suit === firstSuit)) return { valid: false };

  // Helper to check run sequence with 0 or 1 joker
  const checkSequence = (vals: number[]) => {
    vals.sort((a, b) => a - b);
    let gaps = 0;
    for (let i = 0; i < vals.length - 1; i++) {
      const diff = vals[i + 1] - vals[i];
      if (diff === 0) return { valid: false, gaps: 999 };
      gaps += diff - 1;
    }
    return { valid: gaps <= wildcards.length, gaps };
  };

  const lowSeq = checkSequence(naturals.map((c) => RANK_TO_NUM[c.rank]));
  const highSeq = naturals.some((c) => c.rank === "A")
    ? checkSequence(
        naturals.map((c) => (c.rank === "A" ? 14 : RANK_TO_NUM[c.rank]))
      )
    : { valid: false };

  if (lowSeq.valid || highSeq.valid) {
    const basePoints = cards.reduce((sum, c) => sum + getCardPoints(c), 0);
    const isPinnacolone = cards.length >= 13 && wildcards.length === 0;
    if (isPinnacolone)
      return { valid: true, type: "run", points: 600, isPinnacolone: true };

    const isPinnacola = cards.length >= 7 && wildcards.length === 0;
    const finalPoints = isPinnacola ? basePoints * 2 : basePoints;
    return { valid: true, type: "run", points: finalPoints, isPinnacola };
  }

  return { valid: false };
}

function calculateScores(
  projected: ProjectedPiles,
  rulesState: PinnacolaRulesState
): { scores: Record<string, number>; winner: string | null } {
  const players = rulesState.players;
  const handScores: Record<string, number> = {};
  let handWinner = null;

  for (const pid of players) {
    let score = 0;
    const hand = projected[`${pid}-hand`]?.cards ?? [];
    score -= hand.reduce((sum, c) => sum + getCardPoints(c), 0);

    const playerMeldPiles = Object.keys(projected)
      .filter((id) => id.startsWith(`${pid}-meld-`))
      .map((id) => projected[id].cards)
      .filter((cards): cards is SimpleCard[] => !!cards && cards.length > 0);

    for (const meldCards of playerMeldPiles) {
      const v = validateMeld(meldCards);
      if (v.valid) score += v.points ?? 0;
    }

    if (hand.length === 0) {
      let bonus = 100;
      const isInMano = !rulesState.playersWhoDiscarded.includes(pid);
      if (isInMano) bonus = 200;
      score += bonus;
      if (isInMano) score *= 2;
      handWinner = pid;
    }
    handScores[pid] = score;
  }

  return { scores: handScores, winner: handWinner };
}

function recomputeDerived(
  _state: ValidationState,
  rulesState: PinnacolaRulesState,
  engineEvents: EngineEvent[]
): void {
  const updatedRS: PinnacolaRulesState = {
    ...rulesState,
  };

  engineEvents.push({ type: "set-rules-state", rulesState: updatedRS });
}

export const pinnacolaRules: GameRuleModule = {
  listLegalIntentsForPlayer(
    state: ValidationState,
    playerId: string
  ): ClientIntent[] {
    const rs = getPinnacolaRulesState(state.rulesState, ["P1", "P2"]);
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

    if (rs.turnPhase === "must-draw") {
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
      const disc = state.piles["discard"];
      if (disc?.size && disc.cards) {
        for (const c of disc.cards)
          intents.push({
            type: "move",
            gameId: state.gameId,
            playerId,
            fromPileId: "discard",
            toPileId: `${playerId}-hand`,
            cardId: c.id,
          });
      }
    } else if (
      rs.turnPhase === "play-or-discard" ||
      rs.turnPhase === "must-meld-pozzo-top" ||
      rs.turnPhase === "must-reuse-joker"
    ) {
      const meldPiles = meldPileIdsForPlayer(playerId);
      const opponentId = getOtherPlayer(playerId, rs.players);
      const opponentMeldPiles = meldPileIdsForPlayer(opponentId);

      for (const c of hand) {
        if (
          rs.turnPhase === "must-meld-pozzo-top" ||
          rs.turnPhase === "must-reuse-joker"
        ) {
          if (c.id !== rs.mandatoryMeldCardId) continue;
        }
        // Move to own melds
        for (const mid of meldPiles) {
          const targetPile = state.piles[mid];
          const cards =
            targetPile?.cards?.map((pc) => ({
              id: pc.id,
              rank: pc.rank,
              suit: pc.suit,
            })) ?? [];
          const movingCard = c;
          const newCards = [...cards, movingCard];
          if (newCards.length < 3 || validateMeld(newCards).valid) {
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

        // Joker replacement: move natural card to opponent or own meld that has a joker
        for (const mid of [...meldPiles, ...opponentMeldPiles]) {
          const pile = state.piles[mid];
          const joker = pile?.cards?.find((pc) => pc.rank === "JOKER");
          if (joker) {
            const cards =
              pile?.cards?.map((pc) => ({
                id: pc.id,
                rank: pc.rank,
                suit: pc.suit,
              })) ?? [];
            const movingCard = c;
            const withoutJoker = cards.filter((pc) => pc.id !== joker.id);
            const withNatural = [...withoutJoker, movingCard];
            if (validateMeld(withNatural).valid) {
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

        // Discard (only if board valid and not in mandatory phase)
        if (rs.turnPhase === "play-or-discard") {
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

      // Move back cards played this turn
      for (const mid of meldPiles) {
        for (const c of state.piles[mid]?.cards ?? []) {
          if (rs.cardsPlayedToMeldsThisTurn.includes(c.id)) {
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
      }
    }

    return intents;
  },

  validate(state: ValidationState, intent: ClientIntent): ValidationResult {
    const rs = getPinnacolaRulesState(state.rulesState, ["P1", "P2"]);
    const players = rs.players;
    const nextRS = { ...rs };
    const engineEvents: EngineEvent[] = [];

    if (!rs.hasDealt) {
      if (intent.type === "action" && intent.action === "start-game") {
        const nextDeal = rs.dealNumber + 1;

        // Gather all cards back to deck
        engineEvents.push(...gatherAllCards(state));

        // SHUFFLE all cards deterministically
        const shuffled = shuffleAllCards(state, nextDeal, "PINNA");

        // Deal 13 each
        const { events: dealEvents, nextIndex } = distributeRoundRobin(
          shuffled,
          players.map((p) => `${p}-hand`),
          13
        );
        engineEvents.push(...dealEvents);

        engineEvents.push({
          type: "move-cards",
          fromPileId: "deck",
          toPileId: "discard",
          cardIds: [shuffled[nextIndex]],
        });

        nextRS.hasDealt = true;
        nextRS.dealNumber = nextDeal;
        nextRS.phase = "playing";
        nextRS.turnPlayerId = players[nextDeal % players.length];
        nextRS.turnPhase = "must-draw";
        nextRS.playersWhoDiscarded = [];

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
        // Engine guarantees cardId is defined for move intents
        const cardId = intent.cardId!;
        // Engine guarantees card is in source pile

        if (intent.fromPileId === "deck") {
          engineEvents.push({
            type: "move-cards",
            fromPileId: "deck",
            toPileId: `${intent.playerId}-hand`,
            cardIds: [cardId],
          });
          nextRS.turnPhase = "play-or-discard";
        } else if (intent.fromPileId === "discard") {
          const disc = state.piles["discard"];
          const ids = disc.cards!.map((c) => c.id);
          engineEvents.push({
            type: "move-cards",
            fromPileId: "discard",
            toPileId: `${intent.playerId}-hand`,
            cardIds: ids as [number, ...number[]],
          });
          nextRS.turnPhase = "must-meld-pozzo-top";
          nextRS.mandatoryMeldCardId = ids[ids.length - 1]; // Top card (last in array)
        } else
          return {
            valid: false,
            reason: "Draw from deck or discard.",
            engineEvents: [],
          };

        nextRS.cardsPlayedToMeldsThisTurn = [];
        recomputeDerived(state, nextRS, engineEvents);
        return { valid: true, engineEvents };
      }
    }

    if (
      rs.turnPhase === "play-or-discard" ||
      rs.turnPhase === "must-meld-pozzo-top" ||
      rs.turnPhase === "must-reuse-joker"
    ) {
      if (intent.type === "move") {
        // Engine guarantees cardId is defined for move intents and card is in source pile

        const isToOwnMeld = intent.toPileId.startsWith(
          `${intent.playerId}-meld-`
        );
        const isToOppMeld = intent.toPileId.startsWith(
          `${getOtherPlayer(intent.playerId, players)}-meld-`
        );

        if (isToOwnMeld || isToOppMeld) {
          // Only allow moving from own hand
          if (intent.fromPileId !== `${intent.playerId}-hand`) {
            return {
              valid: false,
              reason: "Can only meld cards from your own hand.",
              engineEvents: [],
            };
          }

          if (
            rs.mandatoryMeldCardId &&
            intent.cardId! !== rs.mandatoryMeldCardId
          ) {
            const mc = state.allCards[rs.mandatoryMeldCardId];
            return {
              valid: false,
              reason: `You must use the card ${formatCard(mc.rank, mc.suit)} first.`,
              engineEvents: [],
            };
          }

          const targetPile = state.piles[intent.toPileId];
          const cards =
            targetPile.cards?.map((c) => ({
              id: c.id,
              rank: c.rank,
              suit: c.suit,
            })) ?? [];
          const movingCard = state.allCards[intent.cardId!];

          // Check Joker Replacement
          const joker = cards.find((c) => c.rank === "JOKER");
          if (joker && !isWild(movingCard)) {
            // Check if moving card can replace joker
            const withoutJoker = cards.filter((c) => c.id !== joker.id);
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

          if (isToOppMeld)
            return {
              valid: false,
              reason: "You can only replace Jokers in opponent's melds.",
              engineEvents: [],
            };

          const newCards = [...cards, movingCard];
          if (newCards.length >= 3 && !validateMeld(newCards).valid)
            return { valid: false, reason: "Invalid meld.", engineEvents: [] };

          engineEvents.push({
            type: "move-cards",
            fromPileId: intent.fromPileId,
            toPileId: intent.toPileId,
            cardIds: [intent.cardId!],
          });
          nextRS.cardsPlayedToMeldsThisTurn = [
            ...nextRS.cardsPlayedToMeldsThisTurn,
            intent.cardId!,
          ];
          if (
            rs.turnPhase === "must-meld-pozzo-top" ||
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
          let boardError = null;
          const ownMeldPiles = meldPileIdsForPlayer(intent.playerId);
          for (const mid of ownMeldPiles) {
            const p = state.piles[mid];
            if (p?.size > 0 && p.size < 3) {
              boardError = "All melds must have at least 3 cards.";
              break;
            }
            if (p?.size >= 3 && p.cards && !validateMeld(p.cards).valid) {
              boardError = "One of your melds is invalid.";
              break;
            }
          }

          if (boardError) {
            return { valid: false, reason: boardError, engineEvents: [] };
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

          if (wentOut) {
            let hasPinnacola = false,
              hasPoker = false;
            for (const mid of ownMeldPiles) {
              const cards = projected[mid]?.cards ?? [];
              const v = validateMeld(cards);
              if (v.isPinnacola || v.isPinnacolone) hasPinnacola = true;
              if (v.isPoker) hasPoker = true;
            }
            if (!hasPinnacola || !hasPoker) {
              return {
                valid: false,
                reason:
                  "Closing requires 1 Pinnacola (7+ run) and 1 Poker (4 set).",
                engineEvents: [],
              };
            }

            const { scores } = calculateScores(projected, nextRS);
            const scoreLine = players
              .map((p) => `${p}: ${scores[p]} pts`)
              .join(", ");

            nextRS.result = `Hand ${rs.dealNumber} Result: ${scoreLine}.`;
            for (const p of players) nextRS.cumulativeScores[p] += scores[p];

            const gameWinner = players.find(
              (p) => nextRS.cumulativeScores[p] >= 1000
            );
            if (gameWinner) {
              nextRS.phase = "ended";
              engineEvents.push({ type: "set-winner", winner: gameWinner });
            } else {
              nextRS.hasDealt = false;
              nextRS.phase = "dealing";
            }
          } else {
            nextRS.turnPlayerId = getOtherPlayer(intent.playerId, players);
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

          const cells: ScoreboardCell[] = [
            { row: 0, col: 0, text: "Player", role: "header" },
            { row: 0, col: 1, text: "Score", role: "header" },
          ];
          players.forEach((p, i) => {
            cells.push({ row: i + 1, col: 0, text: p, role: "body" });
            cells.push({
              row: i + 1,
              col: 1,
              text: String(nextRS.cumulativeScores[p]),
              role: "body",
            });
          });
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

        if (
          intent.toPileId === `${intent.playerId}-hand` &&
          intent.fromPileId.startsWith(`${intent.playerId}-meld-`)
        ) {
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
      ...meldPileIdsForPlayer("P1"),
      ...meldPileIdsForPlayer("P2"),
    ],
  },
};
