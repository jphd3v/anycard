import assert from "node:assert/strict";

import type {
  ClientIntent,
  GameEvent,
  GameState,
} from "../../../shared/schemas.js";
import { loadAndValidateGameConfig } from "../../../backend/src/game-config.js";
import { validateMove } from "../../../backend/src/rule-engine.js";
import { GAME_PLUGINS } from "../../../backend/src/rules/registry.js";
import { applyEvent } from "../../../backend/src/state.js";
import { buildValidationState } from "../../../backend/src/validation-state.js";
import {
  assertEngineEventPayloads,
  assertGlobalStateInvariants,
} from "./invariants.js";

function applyEvents(state: GameState, events: GameEvent[]): GameState {
  let nextState = state;
  for (const event of events) {
    nextState = applyEvent(nextState, event);
  }
  return nextState;
}

function listLegalIntentsForPlayerLocal(
  state: GameState,
  events: GameEvent[],
  playerId: string
): ClientIntent[] {
  const plugin = GAME_PLUGINS[state.rulesId];
  if (!plugin || !plugin.ruleModule.listLegalIntentsForPlayer) return [];

  const dummyIntent: ClientIntent = {
    type: "action",
    gameId: state.gameId,
    playerId,
    action: "dummy",
  };
  const validationState = buildValidationState(state, events, dummyIntent);

  const stateBeforeProbe = JSON.stringify(state);
  const validationBeforeProbe = JSON.stringify(validationState);

  const intentsA =
    plugin.ruleModule.listLegalIntentsForPlayer(validationState, playerId) ??
    [];
  const intentsB =
    plugin.ruleModule.listLegalIntentsForPlayer(validationState, playerId) ??
    [];

  assert.deepStrictEqual(
    intentsB,
    intentsA,
    `[integration] legal probe idempotence failed for ${state.rulesId} (${playerId})`
  );
  assert.equal(
    JSON.stringify(state),
    stateBeforeProbe,
    `[integration] legal probe mutated game state for ${state.rulesId} (${playerId})`
  );
  assert.equal(
    JSON.stringify(validationState),
    validationBeforeProbe,
    `[integration] legal probe mutated validation snapshot for ${state.rulesId} (${playerId})`
  );

  return intentsA;
}

function probeViewHelpers(
  state: GameState,
  events: GameEvent[],
  playerId: string
) {
  const plugin = GAME_PLUGINS[state.rulesId];
  if (!plugin) return;

  const dummyIntent: ClientIntent = {
    type: "action",
    gameId: state.gameId,
    playerId,
    action: "dummy",
  };
  const validationState = buildValidationState(state, events, dummyIntent);

  if (plugin.ruleModule.listLegalIntentsForView) {
    const stateBeforeProbe = JSON.stringify(state);
    const intentsA =
      plugin.ruleModule.listLegalIntentsForView(validationState, playerId) ??
      [];
    const intentsB =
      plugin.ruleModule.listLegalIntentsForView(validationState, playerId) ??
      [];
    assert.deepStrictEqual(
      intentsB,
      intentsA,
      `[integration] legal view probe idempotence failed for ${state.rulesId} (${playerId})`
    );
    assert.equal(
      JSON.stringify(state),
      stateBeforeProbe,
      `[integration] legal view probe mutated game state for ${state.rulesId} (${playerId})`
    );
  }

  if (plugin.aiSupport?.buildContext) {
    const publicPiles = Object.values(state.piles).map((pile) => ({
      id: pile.id,
      totalCards: pile.cardIds.length,
      cards: pile.cardIds.map((cardId) => {
        const card = state.cards[cardId];
        return {
          rank: card?.rank,
          suit: card?.suit,
          rotationDeg: state.cardVisuals?.[cardId]?.rotationDeg,
        };
      }),
    }));
    const view = {
      seat: playerId,
      public: {
        rulesState: state.rulesState,
        piles: publicPiles,
        currentPlayer: state.currentPlayer,
        winner: state.winner,
        players: state.players,
        scoreboards: state.scoreboards,
        actions: state.actions,
      },
      private: {},
    };
    const contextA = plugin.aiSupport.buildContext(view);
    const contextB = plugin.aiSupport.buildContext(view);
    assert.deepStrictEqual(
      contextB,
      contextA,
      `[integration] ai context determinism failed for ${state.rulesId} (${playerId})`
    );
  }
}

async function runPluginLegalIntentIsolation(
  rulesId: string,
  forceAiPlayers: boolean
) {
  const seed = `LEGAL-INTENT-ISO-${rulesId}${forceAiPlayers ? "-AI" : ""}`;
  let state = loadAndValidateGameConfig(rulesId, seed);
  if (forceAiPlayers) {
    state = {
      ...state,
      players: state.players.map((player, index) => ({
        ...player,
        isAi: index !== 0,
      })),
    };
  }
  state = { ...state, gameId: `${rulesId}-legal-intent-isolation` };
  const events: GameEvent[] = [];
  assertGlobalStateInvariants(
    state,
    events,
    listLegalIntentsForPlayerLocal,
    `legal-intent-isolation ${rulesId}: initial state`
  );

  const maxSteps = 6;
  for (let step = 0; step < maxSteps; step += 1) {
    if (state.winner) break;
    for (const player of state.players) {
      probeViewHelpers(state, events, player.id);
    }
    const playerId = state.currentPlayer ?? state.players[0]?.id;
    if (!playerId) break;

    const legalIntents = listLegalIntentsForPlayerLocal(
      state,
      events,
      playerId
    );
    if (legalIntents.length === 0) break;

    let advanced = false;
    for (const intent of legalIntents) {
      const chosen = { ...intent, gameId: state.gameId } as ClientIntent;
      const stateBeforeValidate = JSON.stringify(state);
      const eventsBeforeValidate = JSON.stringify(events);

      const resultA = await validateMove(state, events, chosen);
      const resultB = await validateMove(state, events, chosen);

      assert.deepStrictEqual(
        resultB,
        resultA,
        `[integration] validateMove determinism failed for ${rulesId} at step ${step}`
      );
      assert.equal(
        JSON.stringify(state),
        stateBeforeValidate,
        `[integration] validateMove mutated game state for ${rulesId} at step ${step}`
      );
      assert.equal(
        JSON.stringify(events),
        eventsBeforeValidate,
        `[integration] validateMove mutated input event log for ${rulesId} at step ${step}`
      );
      assert.equal(
        resultA.valid,
        true,
        `[integration] legal intent soundness failed for ${rulesId} at step ${step}: ${JSON.stringify(intent)} -> ${resultA.reason ?? "invalid"}`
      );
      assertEngineEventPayloads(
        resultA.engineEvents,
        `legal-intent-isolation ${rulesId}: step ${step}`
      );

      events.push(...resultA.engineEvents);
      state = applyEvents(state, resultA.engineEvents);
      assertGlobalStateInvariants(
        state,
        events,
        listLegalIntentsForPlayerLocal,
        `legal-intent-isolation ${rulesId}: step ${step}`
      );
      advanced = true;
      break;
    }

    if (!advanced) break;
  }

  console.log(
    `[integration] legal intent isolation: ${rulesId}${forceAiPlayers ? " (ai)" : ""} ok`
  );
}

export async function runLegalIntentIsolationTests() {
  const rulesIds = Object.keys(GAME_PLUGINS).sort();
  for (const rulesId of rulesIds) {
    await runPluginLegalIntentIsolation(rulesId, false);
    await runPluginLegalIntentIsolation(rulesId, true);
  }
}
