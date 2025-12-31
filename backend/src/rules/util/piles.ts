// backend/src/rules/util/piles.ts

import type { ValidationState } from "../../validation-state.js";
import type { EngineEvent } from "../../../../shared/validation.js";

/**
 * A simplified representation of a pile for rules logic.
 */
export interface ProjectedPile {
  size: number;
  /** Optional: only present if the rules need to know the specific cards in the pile */
  cardIds?: number[];
  /** Optional: only present if the rules need to know the rank/suit of cards in the pile */
  cards?: Array<{ id: number; rank: string; suit: string }>;
}

export type ProjectedPiles = Record<string, ProjectedPile>;

/**
 * Projects the state of piles after a set of EngineEvents are applied.
 * This is useful for rules that need to calculate scores or validate board state
 * BEFORE the events are actually committed to the engine state.
 *
 * @param state The current validation state
 * @param events The events to project
 * @param options Configuration for what data to include in projection
 */
export function projectPilesAfterEvents(
  state: ValidationState,
  events: EngineEvent[],
  options: { includeCards?: boolean } = { includeCards: true }
): ProjectedPiles {
  const piles: ProjectedPiles = {};

  // 1. Initialize from current state
  for (const [id, pile] of Object.entries(state.piles)) {
    const cards = pile.cards?.map((c) => ({
      id: c.id,
      rank: c.rank,
      suit: c.suit,
    }));
    piles[id] = {
      size: pile.size,
      cardIds: options.includeCards ? cards?.map((c) => c.id) : undefined,
      cards: options.includeCards ? cards : undefined,
    };
  }

  // 2. Apply events
  for (const ev of events) {
    if (ev.type !== "move-cards") continue;

    const from = piles[ev.fromPileId] ?? { size: 0 };
    const to = piles[ev.toPileId] ?? { size: 0 };

    piles[ev.fromPileId] = from;
    piles[ev.toPileId] = to;

    const idsToMove = new Set(ev.cardIds);
    const movedCards: Array<{ id: number; rank: string; suit: string }> = [];

    // Update 'from' pile
    if (from.cardIds) {
      const remainingIds: number[] = [];
      const remainingCards: Array<{ id: number; rank: string; suit: string }> =
        [];

      for (let i = 0; i < from.cardIds.length; i++) {
        const id = from.cardIds[i];
        if (idsToMove.has(id)) {
          const card = from.cards?.[i] ?? state.allCards[id];
          if (card) movedCards.push(card);
        } else {
          remainingIds.push(id);
          if (from.cards?.[i]) remainingCards.push(from.cards[i]);
        }
      }

      from.cardIds = remainingIds;
      if (from.cards) from.cards = remainingCards;
      from.size = remainingIds.length;
    } else {
      from.size = Math.max(0, from.size - ev.cardIds.length);
      if (options.includeCards) {
        for (const id of ev.cardIds) {
          const card = state.allCards[id];
          if (card) movedCards.push(card);
        }
      }
    }

    // Update 'to' pile
    if (to.cardIds) {
      to.cardIds = [...to.cardIds, ...ev.cardIds];
      if (to.cards) to.cards = [...to.cards, ...movedCards];
      to.size = to.cardIds.length;
    } else {
      to.size += ev.cardIds.length;
      if (options.includeCards) {
        to.cardIds = [...ev.cardIds];
        to.cards = [...movedCards];
      }
    }
  }

  return piles;
}
