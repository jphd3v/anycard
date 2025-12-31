import assert from "node:assert/strict";

import type {
  ClientIntent,
  GameEvent,
  GameState,
} from "../../../shared/schemas.js";
import {
  loadAndValidateGameConfig,
  loadInitialState,
} from "../../../backend/src/game-config.js";
import { validateMove } from "../../../backend/src/rule-engine.js";
import {
  applyEvent,
  closeGame,
  initGame,
  projectState,
  resetGameWithSeed,
} from "../../../backend/src/state.js";
import { applyShuffleToState } from "../../../backend/src/shuffler.js";

function applyEvents(state: GameState, events: GameEvent[]): GameState {
  let nextState = state;
  for (const event of events) {
    try {
      nextState = applyEvent(nextState, event);
    } catch (err) {
      if (event.type === "move-cards") {
        const fromPile = nextState.piles[event.fromPileId];
        console.error(
          `[integration] applyEvent failed for move-cards from ${event.fromPileId} to ${event.toPileId}`
        );
        console.error(`[integration] cardIds=${JSON.stringify(event.cardIds)}`);
        console.error(
          `[integration] fromPile.cards=${JSON.stringify(fromPile?.cardIds ?? [])}`
        );
      }
      throw err;
    }
  }
  return nextState;
}

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cardKey(state: GameState, cardId: number): string {
  const card = state.cards[cardId];
  if (!card) return `id:${cardId}`;
  return `${card.rank}-${card.suit}`;
}

function summarizeHands(state: GameState): Record<string, string[]> {
  const handPileIds = Object.keys(state.piles)
    .filter((id) => id.endsWith("-hand"))
    .sort();
  const summary: Record<string, string[]> = {};
  for (const pileId of handPileIds) {
    const pile = state.piles[pileId];
    summary[pileId] = pile.cardIds.map((id) => cardKey(state, id)).sort();
  }
  return summary;
}

function reorderPiles(piles: GameState["piles"]): GameState["piles"] {
  const pileIds = Object.keys(piles).sort().reverse();
  const reordered: GameState["piles"] = {};
  for (const pileId of pileIds) {
    reordered[pileId] = piles[pileId];
  }
  return reordered;
}

function seedHandsFromDeck(
  state: GameState,
  handPileIds: string[],
  cardsPerHand: number
): void {
  const deck = state.piles["deck"];
  if (!deck) {
    throw new Error("[integration] deck pile missing in seedHandsFromDeck");
  }
  const deckCards = [...deck.cardIds];
  let offset = 0;
  for (const pileId of handPileIds) {
    const pile = state.piles[pileId];
    if (!pile) {
      throw new Error(
        `[integration] missing pile ${pileId} in seedHandsFromDeck`
      );
    }
    const slice = deckCards.slice(offset, offset + cardsPerHand);
    offset += cardsPerHand;
    state.piles[pileId] = {
      ...pile,
      cardIds: [...pile.cardIds, ...slice],
    };
  }
  state.piles["deck"] = {
    ...deck,
    cardIds: deckCards.slice(offset),
  };
}

async function applyStartGame(state: GameState): Promise<GameState> {
  const playerId = state.currentPlayer ?? state.players[0]?.id ?? "P1";
  const intent: ClientIntent = {
    type: "action",
    gameId: state.gameId,
    playerId,
    action: "start-game",
  };
  const result = await validateMove(state, [], intent);
  assert.equal(
    result.valid,
    true,
    `start-game intent invalid: ${result.reason ?? "unknown"}`
  );
  return applyEvents(state, result.engineEvents);
}

export async function runDeterministicShuffleTests() {
  await testDeterministicDealSameSeed();
  await testDeterministicDealResetSameSeed();
  await testDeterministicDealDifferentPileOrder();
}

async function testDeterministicDealSameSeed() {
  const seed = "DEAL-SAME-SEED";
  const stateA = loadAndValidateGameConfig("bridge", seed);
  const stateB = loadAndValidateGameConfig("bridge", seed);
  const dealtA = await applyStartGame({
    ...stateA,
    gameId: "bridge-seed-a",
  });
  const dealtB = await applyStartGame({
    ...stateB,
    gameId: "bridge-seed-b",
  });

  assert.deepStrictEqual(
    summarizeHands(dealtA),
    summarizeHands(dealtB),
    "deterministic deal mismatch for identical seed"
  );

  console.log("[integration] deterministic deal: same seed ok");
}

async function testDeterministicDealResetSameSeed() {
  const seed = "DEAL-RESET-SEED";
  const initial = loadAndValidateGameConfig("bridge", seed);
  const gameId = "bridge-reset-seed";
  initGame({ ...initial, gameId });

  try {
    const firstState = projectState(gameId);
    if (!firstState) {
      throw new Error("[integration] bridge reset test: missing state");
    }
    const dealtA = await applyStartGame({ ...firstState, gameId });

    const resetOk = resetGameWithSeed(gameId, seed);
    assert.equal(resetOk, true, "resetGameWithSeed failed");

    const resetState = projectState(gameId);
    if (!resetState) {
      throw new Error("[integration] bridge reset test: missing reset state");
    }
    const dealtB = await applyStartGame({ ...resetState, gameId });

    assert.deepStrictEqual(
      summarizeHands(dealtA),
      summarizeHands(dealtB),
      "deterministic deal mismatch after reset"
    );
  } finally {
    closeGame(gameId);
  }

  console.log("[integration] deterministic deal: reset ok");
}

async function testDeterministicDealDifferentPileOrder() {
  const seed = "DEAL-PILE-ORDER";
  const base = loadInitialState("bridge");
  const baseA = cloneState(base);
  baseA.gameId = "bridge-order-a";
  const baseB = cloneState(base);
  baseB.gameId = "bridge-order-b";
  baseB.piles = reorderPiles(baseB.piles);

  const shuffledA = applyShuffleToState(baseA, seed);
  const shuffledB = applyShuffleToState(baseB, seed);

  const handPileIds = ["N-hand", "E-hand", "S-hand", "W-hand"];
  seedHandsFromDeck(shuffledA, handPileIds, 2);
  seedHandsFromDeck(shuffledB, handPileIds, 2);

  const dealtA = await applyStartGame(shuffledA);
  const dealtB = await applyStartGame(shuffledB);

  assert.deepStrictEqual(
    summarizeHands(dealtA),
    summarizeHands(dealtB),
    "deterministic deal mismatch for differing pile order"
  );

  console.log("[integration] deterministic deal: pile order ok");
}
