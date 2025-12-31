// backend/src/rules/util/dealing.ts

import type { ValidationState } from "../../validation-state.js";
import type { EngineEvent } from "../../../../shared/validation.js";
import { createRandom, fisherYates, stringToSeed } from "../../util/random.js";
import { projectPilesAfterEvents, type ProjectedPiles } from "./piles.js";

/**
 * Gathers all cards from all piles back into a single destination pile (usually "deck").
 * This is the standard first step before a new shuffle and deal.
 * Returns a list of events (one per source pile) to move all cards.
 *
 * @param state Current validation state
 * @param options Configuration options:
 *        - toPileId: The destination pile (default "deck")
 *        - projectedPiles: If the caller already projected the state (e.g. after a trick move),
 *                          pass it here. Otherwise, it will be projected from state + previousEvents.
 *        - previousEvents: If projectedPiles is not provided, these events will be included
 *                          in the internal projection before gathering.
 */
export function gatherAllCards(
  state: ValidationState,
  options: {
    toPileId?: string;
    projectedPiles?: ProjectedPiles;
    previousEvents?: EngineEvent[];
  } = {}
): EngineEvent[] {
  const toPileId = options.toPileId ?? "deck";
  const events: EngineEvent[] = [];

  // Use provided projection or create one from state + previous events
  const projected =
    options.projectedPiles ??
    projectPilesAfterEvents(state, options.previousEvents ?? [], {
      includeCards: true,
    });

  for (const [fromPileId, pile] of Object.entries(projected)) {
    if (fromPileId === toPileId) continue;

    // We use cardIds if available (preferred), otherwise fall back to cards array
    const cardIds = pile.cardIds ?? (pile.cards ?? []).map((c) => c.id) ?? [];

    if (cardIds.length > 0) {
      events.push({
        type: "move-cards",
        fromPileId,
        toPileId,
        cardIds: cardIds as [number, ...number[]],
      });
    }
  }
  return events;
}

/**
 * Generates a deterministic shuffle of ALL cards registered in the game.
 *
 * @param state Current validation state (contains seed and allCards)
 * @param shuffleIndex A counter that increments every time we reshuffle the deck
 *                     (usually dealNumber, but some games like Katko reshuffle less often)
 * @param defaultSeed Fallback seed string if state.seed is missing
 * @param options Configuration options:
 *        - useCurrentDeckIfFull: If true, and the "deck" pile already contains all cards,
 *                                use its current order as the input to the shuffle.
 *                                This maintains backward compatibility with games that double-shuffled.
 *                                Default: true.
 */
export function shuffleAllCards(
  state: ValidationState,
  shuffleIndex: number,
  defaultSeed: string,
  options: { useCurrentDeckIfFull?: boolean } = { useCurrentDeckIfFull: true }
): number[] {
  // Collect ALL card IDs from the global card registry to ensure we have the full deck
  const allCardIdsSorted = Object.keys(state.allCards)
    .map(Number)
    .sort((a, b) => a - b);

  // To maintain backward compatibility with games that double-shuffled,
  // we check if the deck already contains all cards and use that order as input.
  const deckPile = state.piles["deck"];
  const deckCardIds = (deckPile?.cards ?? []).map((c) => c.id);

  const shuffleInput =
    options.useCurrentDeckIfFull &&
    deckCardIds.length === allCardIdsSorted.length
      ? deckCardIds
      : allCardIdsSorted;

  const baseSeed = stringToSeed(state.seed || defaultSeed);
  const random = createRandom(baseSeed + shuffleIndex);

  return fisherYates(shuffleInput, random);
}

/**
 * Distributes cards from a source pile to a list of target piles in a round-robin fashion.
 *
 * @param cardIds The list of card IDs to distribute (usually the result of shuffleAllCards)
 * @param targetPileIds The piles to receive cards (e.g. ["P1-hand", "P2-hand"])
 * @param cardsPerPile How many cards each target pile should receive
 * @param fromPileId The source pile ID (usually "deck")
 * @param startIndex The index in the cardIds array to start from
 */
export function distributeRoundRobin(
  cardIds: number[],
  targetPileIds: readonly string[],
  cardsPerPile: number,
  startIndex: number = 0,
  fromPileId: string = "deck"
): { events: EngineEvent[]; nextIndex: number } {
  const events: EngineEvent[] = [];
  let currentIdx = startIndex;

  for (let i = 0; i < cardsPerPile; i++) {
    for (const pileId of targetPileIds) {
      if (currentIdx >= cardIds.length) break;
      events.push({
        type: "move-cards",
        fromPileId,
        toPileId: pileId,
        cardIds: [cardIds[currentIdx]],
      });
      currentIdx++;
    }
  }

  return { events, nextIndex: currentIdx };
}
