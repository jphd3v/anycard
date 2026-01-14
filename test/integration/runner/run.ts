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

type ScenarioExpect = {
  winner?: string | null;
  currentPlayer?: string | null;
  scoreboards?: unknown;
  rulesState?: unknown;
  cardVisuals?: Record<number, { rotationDeg?: number }>;
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
};

type Scenario = {
  id?: string;
  rulesId: string;
  seed?: string;
  gameId?: string;
  players?: ScenarioPlayer[];
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

function initializeScenarioState(scenario: Scenario) {
  let state = loadAndValidateGameConfig(scenario.rulesId, scenario.seed);
  const gameId = scenario.gameId ?? `${scenario.rulesId}-integration`;
  state = { ...state, gameId };

  const normalizedPlayers = normalizePlayers(scenario.players);
  if (normalizedPlayers) {
    state = { ...state, players: normalizedPlayers };
  }

  return { state, gameId };
}

async function runScriptedScenario(label: string, scenario: Scenario) {
  const { state: initialState, gameId } = initializeScenarioState(scenario);
  let state = initialState;
  const events: GameEvent[] = [];
  const intents = scenario.intents ?? [];

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

    const result = await validateMove(state, events, intentWithGameId);
    if (!result.valid) {
      if (intent.expectedError) {
        if (result.reason?.includes(intent.expectedError)) {
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

    for (const event of result.engineEvents) {
      events.push(event);
    }

    state = applyEvents(state, result.engineEvents);
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

    for (const event of result.engineEvents) {
      events.push(event);
    }

    state = applyEvents(state, result.engineEvents);

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
