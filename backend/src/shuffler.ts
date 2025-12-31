import type { GameState, Pile } from "../../shared/schemas.js";
import { createRandom, fisherYates, stringToSeed } from "./util/random.js";

export function applyShuffleToState(
  state: GameState,
  seedString?: string
): GameState {
  const normalizedSeed =
    typeof seedString === "string" && seedString.trim().length > 0
      ? seedString.trim()
      : typeof state.seed === "string" && state.seed.trim().length > 0
        ? state.seed.trim()
        : Date.now().toString(36);
  // If no seed provided, default to a timestamp-based one; canonicalize to upper-case for readability
  const seedKey = normalizedSeed.toUpperCase();
  const seedNum = stringToSeed(seedKey);
  const random = createRandom(seedNum);

  const label = state.rulesId ?? state.gameId ?? "unknown";
  console.log(`[Game ${label}] Shuffling decks with seed: "${seedKey}"`);

  const nextState: GameState = {
    ...state,
    seed: seedKey,
    piles: { ...state.piles },
  };

  type ShuffleGroup = {
    pileIds: string[];
    lengths: number[];
    cards: number[];
  };

  const groups = new Map<string, ShuffleGroup>();
  const pileIds = Object.keys(nextState.piles).sort();

  for (const pileId of pileIds) {
    const pile = nextState.piles[pileId];
    if (!pile.shuffleGroup) continue;
    const id = pile.shuffleGroup;
    let group = groups.get(id);
    if (!group) {
      group = { pileIds: [], lengths: [], cards: [] };
      groups.set(id, group);
    }
    group.pileIds.push(pile.id);
    group.lengths.push(pile.cardIds.length);
    group.cards.push(...pile.cardIds);
  }

  const groupIds = Array.from(groups.keys()).sort();
  for (const groupId of groupIds) {
    const group = groups.get(groupId);
    if (!group) continue;
    const orderedCards = [...group.cards].sort((a, b) => a - b);
    const cards = fisherYates(orderedCards, random);
    let offset = 0;
    group.pileIds.forEach((pileId, index) => {
      const len = group.lengths[index];
      const slice = cards.slice(offset, offset + len);
      offset += len;
      const pile = nextState.piles[pileId] as Pile;
      nextState.piles[pileId] = { ...pile, cardIds: slice };
    });
  }

  for (const pileId of pileIds) {
    const typedPile = nextState.piles[pileId] as Pile;
    if (!typedPile.shuffle || typedPile.shuffleGroup) {
      continue;
    }
    nextState.piles[pileId] = {
      ...typedPile,
      cardIds: fisherYates(
        [...typedPile.cardIds].sort((a, b) => a - b),
        random
      ),
    };
  }

  return nextState;
}
