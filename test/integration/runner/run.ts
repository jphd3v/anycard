import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ClientIntent,
  GameEvent,
  GameState,
  Player,
} from "../../../shared/schemas.js";
import { loadAndValidateGameConfig } from "../../../backend/src/game-config.js";
import { buildValidationState } from "../../../backend/src/validation-state.js";
import { GAME_PLUGINS } from "../../../backend/src/rules/registry.js";
import { validateMove } from "../../../backend/src/rule-engine.js";
import { applyEvent } from "../../../backend/src/state.js";
import { runDeterministicShuffleTests } from "./deterministic-shuffle.js";
import { runLegalIntentIsolationTests } from "./legal-intent-isolation.js";
import {
  assertEngineEventPayloads,
  assertGlobalStateInvariants,
} from "./invariants.js";

type ScenarioExpect = {
  winner?: string | null;
  currentPlayer?: string | null;
  actions?: unknown;
  scoreboards?: unknown;
  rulesState?: unknown;
  cardVisuals?: Record<number, { rotationDeg?: number }>;
  pileProperties?: Record<
    string,
    { layout?: string; label?: string; isHand?: boolean }
  >;
  piles?:
    | Record<
        string,
        {
          cardIds?: number[];
          size?: number;
          minSize?: number;
          visibility?: string;
        }
      >
    | undefined;
};

type ScenarioEventExpect = {
  includeTypes?: string[];
  excludeTypes?: string[];
  exactTypes?: string[];
  minCounts?: Record<string, number>;
  maxCounts?: Record<string, number>;
};

type ScenarioPlayer = {
  id: string;
  name?: string;
  isAi?: boolean;
};

type ScenarioAuto = {
  policy?: "first-legal";
  maxMoves?: number;
  logEvery?: number;
  stopWhen?: {
    dealNumberAtLeast?: number;
  };
};

type ScenarioIntent = ClientIntent & {
  expectedError?: string;
  expectEvents?: ScenarioEventExpect;
  probeLegalIntents?: number;
};

type Scenario = {
  id?: string;
  tags?: string[];
  rulesId: string;
  seed?: string;
  gameId?: string;
  players?: ScenarioPlayer[];
  initialRulesState?: unknown;
  mode?: "scripted" | "auto";
  intents?: ScenarioIntent[];
  auto?: ScenarioAuto;
  expect?: ScenarioExpect;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
const scenariosDir = path.join(repoRoot, "test/integration/scenarios");

function loadScenario(filePath: string): Scenario {
  const raw = fs.readFileSync(filePath, "utf8");
  const json = JSON.parse(raw) as Scenario;

  if (!json || typeof json !== "object") {
    throw new Error("Scenario is not an object");
  }
  if (typeof json.rulesId !== "string" || json.rulesId.length === 0) {
    throw new Error("Scenario is missing rulesId");
  }
  if (json.mode !== "auto" && !Array.isArray(json.intents)) {
    throw new Error("Scenario is missing intents[]");
  }

  return json;
}

function normalizePlayers(
  players: ScenarioPlayer[] | undefined
): Player[] | undefined {
  if (!players) return undefined;
  return players.map((player) => ({
    id: player.id,
    name: player.name ?? player.id,
    isAi: player.isAi ?? false,
    aiRuntime: "none",
    aiSponsorConnectionId: null,
  }));
}

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
  return (
    plugin.ruleModule.listLegalIntentsForPlayer(validationState, playerId) ?? []
  );
}

function assertIntentEventExpectations(
  label: string,
  index: number,
  events: GameEvent[],
  expectEvents?: ScenarioEventExpect
) {
  if (!expectEvents) return;

  const eventTypes = events.map((event) => event.type);
  const eventTypeCounts = new Map<string, number>();
  for (const eventType of eventTypes) {
    eventTypeCounts.set(eventType, (eventTypeCounts.get(eventType) ?? 0) + 1);
  }

  for (const eventType of expectEvents.includeTypes ?? []) {
    assert.ok(
      eventTypeCounts.has(eventType),
      `[integration] ${label}: intent ${index} expected event type '${eventType}', got [${eventTypes.join(", ")}]`
    );
  }

  for (const eventType of expectEvents.excludeTypes ?? []) {
    assert.ok(
      !eventTypeCounts.has(eventType),
      `[integration] ${label}: intent ${index} expected no event type '${eventType}', got [${eventTypes.join(", ")}]`
    );
  }

  if (expectEvents.exactTypes) {
    const expectedSorted = [...expectEvents.exactTypes].sort();
    const actualSorted = [...eventTypes].sort();
    assert.deepStrictEqual(
      actualSorted,
      expectedSorted,
      `[integration] ${label}: intent ${index} exact event types mismatch`
    );
  }

  for (const [eventType, minCount] of Object.entries(
    expectEvents.minCounts ?? {}
  )) {
    assert.ok(
      (eventTypeCounts.get(eventType) ?? 0) >= minCount,
      `[integration] ${label}: intent ${index} expected at least ${minCount} '${eventType}' event(s), got ${eventTypeCounts.get(eventType) ?? 0}`
    );
  }

  for (const [eventType, maxCount] of Object.entries(
    expectEvents.maxCounts ?? {}
  )) {
    assert.ok(
      (eventTypeCounts.get(eventType) ?? 0) <= maxCount,
      `[integration] ${label}: intent ${index} expected at most ${maxCount} '${eventType}' event(s), got ${eventTypeCounts.get(eventType) ?? 0}`
    );
  }
}

function assertExpectations(state: GameState, expect?: ScenarioExpect) {
  if (!expect) return;

  if (expect.winner !== undefined) {
    assert.equal(state.winner, expect.winner, "winner mismatch");
  }

  if (expect.currentPlayer !== undefined) {
    assert.equal(
      state.currentPlayer,
      expect.currentPlayer,
      "currentPlayer mismatch"
    );
  }

  if (expect.actions !== undefined) {
    assert.deepStrictEqual(state.actions, expect.actions, "actions mismatch");
  }

  if (expect.scoreboards !== undefined) {
    assert.deepStrictEqual(
      state.scoreboards,
      expect.scoreboards,
      "scoreboards mismatch"
    );
  }

  if (expect.rulesState !== undefined) {
    let actualRulesState = state.rulesState;
    if (
      typeof actualRulesState === "object" &&
      actualRulesState !== null &&
      typeof expect.rulesState === "object" &&
      expect.rulesState !== null
    ) {
      const expectedRS = expect.rulesState as Record<string, unknown>;
      const actualRS = actualRulesState as Record<string, unknown>;
      // If the expectation doesn't explicitly check recap, ignore it.
      // Recap is managed centrally now, not per-game.
      let filteredRS = { ...actualRS };
      if (!("recap" in expectedRS) && "recap" in filteredRS) {
        const { recap: _, ...rest } = filteredRS;
        filteredRS = rest as any;
      }
      actualRulesState = filteredRS;
    }
    assert.deepStrictEqual(
      actualRulesState,
      expect.rulesState,
      "rulesState mismatch"
    );
  }

  if (expect.cardVisuals !== undefined) {
    assert.deepStrictEqual(
      state.cardVisuals,
      expect.cardVisuals,
      "cardVisuals mismatch"
    );
  }

  if (expect.pileProperties !== undefined) {
    const pileProperties = state.pileProperties ?? {};
    for (const [pileId, expectedProps] of Object.entries(
      expect.pileProperties
    )) {
      const actualProps = pileProperties[pileId];
      assert.ok(actualProps, `pileProperties missing for '${pileId}'`);
      if (expectedProps.layout !== undefined) {
        assert.equal(
          actualProps.layout,
          expectedProps.layout,
          `pileProperties '${pileId}' layout mismatch`
        );
      }
      if (expectedProps.label !== undefined) {
        assert.equal(
          actualProps.label,
          expectedProps.label,
          `pileProperties '${pileId}' label mismatch`
        );
      }
      if (expectedProps.isHand !== undefined) {
        assert.equal(
          actualProps.isHand,
          expectedProps.isHand,
          `pileProperties '${pileId}' isHand mismatch`
        );
      }
    }
  }

  if (expect.piles !== undefined) {
    for (const [pileId, pileExpectation] of Object.entries(expect.piles)) {
      const pile = state.piles[pileId];
      assert.ok(pile, `pile '${pileId}' missing`);

      if (pileExpectation.cardIds !== undefined) {
        assert.deepStrictEqual(
          pile.cardIds,
          pileExpectation.cardIds,
          `pile '${pileId}' cardIds mismatch`
        );
      }

      if (pileExpectation.size !== undefined) {
        assert.equal(
          pile.cardIds.length,
          pileExpectation.size,
          `pile '${pileId}' size mismatch`
        );
      }

      if (pileExpectation.minSize !== undefined) {
        assert.ok(
          pile.cardIds.length >= pileExpectation.minSize,
          `pile '${pileId}' expected minSize ${pileExpectation.minSize}, got ${pile.cardIds.length}`
        );
      }

      if (pileExpectation.visibility !== undefined) {
        assert.equal(
          pile.visibility,
          pileExpectation.visibility,
          `pile '${pileId}' visibility mismatch`
        );
      }
    }
  }
}

function isBetweenRoundsState(state: GameState): boolean {
  if (state.winner) return false;
  if (!state.rulesState || typeof state.rulesState !== "object") return false;

  const rulesState = state.rulesState as Record<string, unknown>;
  if (rulesState.hasDealt !== false) return false;

  const getFiniteNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

  const dealNumber = getFiniteNumber(rulesState.dealNumber);
  const roundNumber = getFiniteNumber(rulesState.roundNumber);
  const handNumber = getFiniteNumber(rulesState.handNumber);
  const resultText =
    typeof rulesState.result === "string" ? rulesState.result.trim() : "";

  const hasProgressed =
    (dealNumber !== null && dealNumber > 0) ||
    (roundNumber !== null && roundNumber > 1) ||
    (handNumber !== null && handNumber > 1) ||
    resultText.length > 0;
  return hasProgressed;
}

function assertNoPrematureRoundGatherOnTransition(
  label: string,
  prevState: GameState,
  nextState: GameState,
  events: GameEvent[],
  stepLabel: string
) {
  if (!isBetweenRoundsState(nextState)) return;
  if (prevState.winner || nextState.winner) return;

  const prevRulesState =
    prevState.rulesState && typeof prevState.rulesState === "object"
      ? (prevState.rulesState as Record<string, unknown>)
      : null;
  if (!prevRulesState || prevRulesState.hasDealt !== true) return;

  const moveToDeckEvents = events.filter(
    (event): event is Extract<GameEvent, { type: "move-cards" }> =>
      event.type === "move-cards" && event.toPileId === "deck"
  );
  if (moveToDeckEvents.length === 0) return;

  const distinctFromPiles = new Set(
    moveToDeckEvents.map((event) => event.fromPileId)
  );
  const hasLargeNonTrickMove = moveToDeckEvents.some(
    (event) =>
      event.cardIds.length >= 20 &&
      event.fromPileId !== "table" &&
      event.fromPileId !== "trick"
  );

  assert.ok(
    distinctFromPiles.size < 2 && !hasLargeNonTrickMove,
    `[integration] ${label}: deferred round reset invariant failed. Between-round transition appears to gather cards into deck before start-game. (at ${stepLabel})`
  );
}

function initializeScenarioState(scenario: Scenario) {
  let state = loadAndValidateGameConfig(scenario.rulesId, scenario.seed);
  const gameId = scenario.gameId ?? `${scenario.rulesId}-integration`;
  state = { ...state, gameId };

  const normalizedPlayers = normalizePlayers(scenario.players);
  if (normalizedPlayers) {
    state = { ...state, players: normalizedPlayers };
  }

  if (
    scenario.initialRulesState &&
    typeof scenario.initialRulesState === "object" &&
    !Array.isArray(scenario.initialRulesState)
  ) {
    const baseRulesState =
      state.rulesState && typeof state.rulesState === "object"
        ? (state.rulesState as Record<string, unknown>)
        : {};
    state = {
      ...state,
      rulesState: {
        ...baseRulesState,
        ...(scenario.initialRulesState as Record<string, unknown>),
      },
    };
  }

  return { state, gameId };
}

async function runScriptedScenario(label: string, scenario: Scenario) {
  const { state: initialState, gameId } = initializeScenarioState(scenario);
  let state = initialState;
  const events: GameEvent[] = [];
  const intents = scenario.intents ?? [];

  assertGlobalStateInvariants(
    state,
    events,
    listLegalIntentsForPlayerLocal,
    `${label}: initial state`
  );

  if (intents.length === 0) {
    console.warn(`[integration] ${label}: no intents provided`);
  }

  for (let index = 0; index < intents.length; index += 1) {
    const intent = intents[index];
    const intentWithGameId = { ...intent, gameId } as ClientIntent;

    if (
      typeof (intentWithGameId as { playerId?: unknown }).playerId !== "string"
    ) {
      throw new Error(
        `[integration] ${label}: intent ${index} missing playerId`
      );
    }
    const actingPlayerId = (intentWithGameId as { playerId: string }).playerId;
    const probeCount = Math.max(
      0,
      Math.floor(
        (intent as { probeLegalIntents?: number }).probeLegalIntents ?? 0
      )
    );
    for (let probeIndex = 0; probeIndex < probeCount; probeIndex += 1) {
      listLegalIntentsForPlayerLocal(state, events, actingPlayerId);
    }

    const result = await validateMove(state, events, intentWithGameId);
    if (!result.valid) {
      if (intent.expectedError) {
        if (result.reason?.includes(intent.expectedError)) {
          assertIntentEventExpectations(
            label,
            index,
            result.engineEvents,
            intent.expectEvents
          );
          assertEngineEventPayloads(
            result.engineEvents,
            `${label}: intent ${index} (expected error)`
          );
          // Expected failure, continue to next intent (but this intent didn't change state)
          continue;
        } else {
          throw new Error(
            `[integration] ${label}: intent ${index} failed as expected but with wrong reason. Expected: "${intent.expectedError}", Got: "${result.reason}"`
          );
        }
      }
      throw new Error(
        `[integration] ${label}: intent ${index} invalid: ${result.reason ?? "unknown"}`
      );
    } else if (intent.expectedError) {
      throw new Error(
        `[integration] ${label}: intent ${index} succeeded but was expected to fail with "${intent.expectedError}"`
      );
    }

    assertIntentEventExpectations(
      label,
      index,
      result.engineEvents,
      intent.expectEvents
    );
    assertEngineEventPayloads(result.engineEvents, `${label}: intent ${index}`);

    for (const event of result.engineEvents) {
      events.push(event);
    }

    const previousState = state;
    state = applyEvents(state, result.engineEvents);
    assertNoPrematureRoundGatherOnTransition(
      label,
      previousState,
      state,
      result.engineEvents,
      `scripted intent ${index}`
    );
    assertGlobalStateInvariants(
      state,
      events,
      listLegalIntentsForPlayerLocal,
      `${label}: scripted intent ${index}`
    );
  }

  assertExpectations(state, scenario.expect);
  console.log(`[integration] ${label}: ok`);
}

async function runAutoScenario(label: string, scenario: Scenario) {
  const { state: initialState } = initializeScenarioState(scenario);
  let state = initialState;
  const events: GameEvent[] = [];
  const auto = scenario.auto ?? {};
  const maxMoves = auto.maxMoves ?? 5000;
  const logEvery = auto.logEvery ?? 0;
  const stopWhen = auto.stopWhen;
  let stopReached = false;

  assertGlobalStateInvariants(
    state,
    events,
    listLegalIntentsForPlayerLocal,
    `${label}: initial state`
  );

  for (let index = 0; index < maxMoves; index += 1) {
    if (state.winner) break;

    const currentPlayer = state.currentPlayer ?? state.players[0]?.id;
    if (!currentPlayer) {
      throw new Error(`[integration] ${label}: no current player available`);
    }

    const legalIntents = listLegalIntentsForPlayerLocal(
      state,
      events,
      currentPlayer
    );
    if (legalIntents.length === 0) {
      const rulesState = state.rulesState as { phase?: string } | null;
      if (rulesState?.phase === "ended") {
        stopReached = true;
        break;
      }
      throw new Error(
        `[integration] ${label}: no legal intents for player ${currentPlayer} at step ${index}`
      );
    }

    const chosen = legalIntents[0];
    const intentWithGameId = {
      ...chosen,
      gameId: state.gameId,
    } as ClientIntent;

    if (intentWithGameId.type === "move") {
      const fromPile = state.piles[intentWithGameId.fromPileId];
      const cardIds =
        intentWithGameId.cardIds ??
        (intentWithGameId.cardId !== undefined
          ? [intentWithGameId.cardId]
          : []);

      if (!fromPile || cardIds.length === 0) {
        const rulesState = state.rulesState as {
          play?: { turnSeat?: string };
        } | null;
        const turnSeat = rulesState?.play?.turnSeat ?? null;
        throw new Error(
          `[integration] ${label}: auto intent card missing at step ${index}\n` +
            `player=${currentPlayer} turnSeat=${turnSeat}\n` +
            `fromPile=${intentWithGameId.fromPileId} cardId=${intentWithGameId.cardId} cardIds=${JSON.stringify(intentWithGameId.cardIds)}\n` +
            `pileCards=${JSON.stringify(fromPile?.cardIds ?? [])}`
        );
      }

      for (const cardId of cardIds) {
        if (!fromPile.cardIds.includes(cardId)) {
          const rulesState = state.rulesState as {
            play?: { turnSeat?: string };
          } | null;
          const turnSeat = rulesState?.play?.turnSeat ?? null;
          throw new Error(
            `[integration] ${label}: auto intent card missing at step ${index}\n` +
              `player=${currentPlayer} turnSeat=${turnSeat}\n` +
              `fromPile=${intentWithGameId.fromPileId} cardId=${cardId}\n` +
              `pileCards=${JSON.stringify(fromPile?.cardIds ?? [])}`
          );
        }
      }
    }

    if (logEvery > 0 && index % logEvery === 0) {
      console.log(
        `[integration] ${label}: step ${index} player ${currentPlayer} intent ${intentWithGameId.type}`
      );
    }

    const result = await validateMove(state, events, intentWithGameId);
    if (!result.valid) {
      throw new Error(
        `[integration] ${label}: auto intent invalid at step ${index}: ${result.reason ?? "unknown"}`
      );
    }
    assertEngineEventPayloads(
      result.engineEvents,
      `${label}: auto step ${index}`
    );

    for (const event of result.engineEvents) {
      events.push(event);
    }

    const previousState = state;
    state = applyEvents(state, result.engineEvents);
    assertNoPrematureRoundGatherOnTransition(
      label,
      previousState,
      state,
      result.engineEvents,
      `auto step ${index}`
    );
    assertGlobalStateInvariants(
      state,
      events,
      listLegalIntentsForPlayerLocal,
      `${label}: auto step ${index}`
    );

    if (stopWhen?.dealNumberAtLeast !== undefined) {
      const rulesState = state.rulesState as { dealNumber?: number } | null;
      const dealNumber = rulesState?.dealNumber ?? 0;
      if (dealNumber >= stopWhen.dealNumberAtLeast) {
        stopReached = true;
        break;
      }
    }
  }

  if (!state.winner && !stopReached) {
    throw new Error(
      `[integration] ${label}: auto run exceeded ${maxMoves} moves without winner`
    );
  }
  if (stopWhen && !stopReached) {
    throw new Error(
      `[integration] ${label}: auto run exceeded ${maxMoves} moves without reaching stop condition`
    );
  }

  assertExpectations(state, scenario.expect);
  console.log(
    `[integration] ${label}: ok${state.winner ? ` (winner ${state.winner})` : ""}`
  );
}

async function runScenario(filePath: string) {
  const scenario = loadScenario(filePath);
  const label = scenario.id ?? path.basename(filePath);
  const mode = scenario.mode ?? "scripted";

  if (mode === "auto") {
    await runAutoScenario(label, scenario);
  } else {
    await runScriptedScenario(label, scenario);
  }
}

function findScenariosRecursive(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const res = path.resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findScenariosRecursive(res));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".json") &&
      !entry.name.startsWith("_")
    ) {
      files.push(res);
    }
  }

  return files;
}

async function main() {
  await runDeterministicShuffleTests();
  await runLegalIntentIsolationTests();

  const args = process.argv.slice(2);
  let files: string[] = [];

  if (args.length > 0) {
    for (const arg of args) {
      const fullPath = path.resolve(repoRoot, arg);
      if (fs.existsSync(fullPath)) {
        if (fs.statSync(fullPath).isDirectory()) {
          files.push(...findScenariosRecursive(fullPath));
        } else {
          files.push(fullPath);
        }
      } else {
        // Try relative to scenariosDir
        const fallbackPath = path.resolve(scenariosDir, arg);
        if (fs.existsSync(fallbackPath)) {
          if (fs.statSync(fallbackPath).isDirectory()) {
            files.push(...findScenariosRecursive(fallbackPath));
          } else {
            files.push(fallbackPath);
          }
        } else {
          console.warn(`[integration] path not found: ${arg}`);
        }
      }
    }
  } else {
    if (!fs.existsSync(scenariosDir)) {
      console.log(
        "[integration] scenarios directory not found; nothing to run"
      );
      return;
    }
    files = findScenariosRecursive(scenariosDir);
  }

  files.sort();

  if (files.length === 0) {
    console.log("[integration] no scenarios found");
    return;
  }

  for (const file of files) {
    await runScenario(file);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
