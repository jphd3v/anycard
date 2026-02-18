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
  assertCardConservation,
  assertEngineEventPayloads,
} from "./invariants.js";

type LivenessFailure = {
  kind:
    | "no-legal-intents"
    | "current-player-stuck"
    | "loop-detected"
    | "no-valid-legal-intent"
    | "apply-events-failed"
    | "invariant-failed";
  step: number;
  message: string;
};

type LivenessRunResult = {
  rulesId: string;
  seed: string;
  variant: number;
  ok: boolean;
  winner: string | null;
  steps: number;
  failure?: LivenessFailure;
};

function parseIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.trunc(value);
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

function applyEvents(state: GameState, events: GameEvent[]): GameState {
  let nextState = state;
  for (const event of events) {
    nextState = applyEvent(nextState, event);
  }
  return nextState;
}

function stateFingerprint(state: GameState): string {
  const pileSummary = Object.values(state.piles)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((pile) => `${pile.id}:${pile.cardIds.join(",")}`)
    .join("|");
  const actionsSummary = state.actions.cells
    .map((action) => `${action.id}:${action.enabled ? "1" : "0"}`)
    .sort()
    .join("|");
  const rulesStateSummary = JSON.stringify(state.rulesState ?? null);
  return [
    state.currentPlayer ?? "none",
    state.winner ?? "none",
    pileSummary,
    actionsSummary,
    rulesStateSummary,
  ].join("::");
}

function summarizeState(state: GameState): string {
  const rulesState =
    state.rulesState && typeof state.rulesState === "object"
      ? (state.rulesState as Record<string, unknown>)
      : {};
  const hands = state.players.map((player) => ({
    playerId: player.id,
    handSize: state.piles[`${player.id}-hand`]?.cardIds.length ?? null,
  }));
  const enabledActions = state.actions.cells
    .filter((cell) => cell.enabled)
    .map((cell) => cell.id);
  const summary = {
    currentPlayer: state.currentPlayer,
    winner: state.winner,
    phase: rulesState.phase ?? null,
    dealNumber: rulesState.dealNumber ?? null,
    roundNumber: rulesState.roundNumber ?? null,
    handNumber: rulesState.handNumber ?? null,
    deckSize: state.piles.deck?.cardIds.length ?? null,
    discardSize: state.piles.discard?.cardIds.length ?? null,
    tableSize: state.piles.table?.cardIds.length ?? null,
    enabledActions,
    hands,
  };
  return JSON.stringify(summary);
}

function withAiProfile(state: GameState, variant: number): GameState {
  const profile = variant % 3;
  if (profile === 0) {
    return {
      ...state,
      players: state.players.map((player) => ({ ...player, isAi: false })),
    };
  }
  if (profile === 1) {
    return {
      ...state,
      players: state.players.map((player, index) => ({
        ...player,
        isAi: index !== 0,
      })),
    };
  }
  return {
    ...state,
    players: state.players.map((player) => ({ ...player, isAi: true })),
  };
}

function collectAllCandidates(
  state: GameState,
  events: GameEvent[]
): ClientIntent[] {
  const all: ClientIntent[] = [];
  for (const player of state.players) {
    all.push(...listLegalIntentsForPlayerLocal(state, events, player.id));
  }
  return all;
}

function collectCandidates(
  state: GameState,
  events: GameEvent[]
): {
  candidates: ClientIntent[];
  source: string;
  currentPlayerCandidates: ClientIntent[];
} {
  const currentPlayer = state.currentPlayer;
  if (currentPlayer) {
    const currentPlayerCandidates = listLegalIntentsForPlayerLocal(
      state,
      events,
      currentPlayer
    );
    if (currentPlayerCandidates.length > 0) {
      return {
        candidates: currentPlayerCandidates,
        source: `current:${currentPlayer}`,
        currentPlayerCandidates,
      };
    }

    return {
      candidates: [],
      source: `current:${currentPlayer}`,
      currentPlayerCandidates,
    };
  }

  const allCandidates = collectAllCandidates(state, events);
  return {
    candidates: allCandidates,
    source: "all-players",
    currentPlayerCandidates: [],
  };
}

async function runSingleVariant(
  rulesId: string,
  variant: number,
  maxMoves: number,
  repeatLimit: number,
  logEvery: number
): Promise<LivenessRunResult> {
  const seed = `LIVENESS-${rulesId}-${variant}`;
  let state = loadAndValidateGameConfig(rulesId, seed);
  state = withAiProfile(state, variant);
  state = { ...state, gameId: `${rulesId}-liveness-${variant}` };
  const events: GameEvent[] = [];
  const seenStates = new Map<string, number>();

  try {
    assertCardConservation(state, `liveness ${rulesId}/${seed}: initial`);
  } catch (err) {
    return {
      rulesId,
      seed,
      variant,
      ok: false,
      winner: state.winner,
      steps: 0,
      failure: {
        kind: "invariant-failed",
        step: 0,
        message: `${String(err)} state=${summarizeState(state)}`,
      },
    };
  }

  for (let step = 0; step < maxMoves; step += 1) {
    if (state.winner) {
      return {
        rulesId,
        seed,
        variant,
        ok: true,
        winner: state.winner,
        steps: step,
      };
    }

    const fingerprint = stateFingerprint(state);
    const seenCount = (seenStates.get(fingerprint) ?? 0) + 1;
    seenStates.set(fingerprint, seenCount);
    if (seenCount > repeatLimit) {
      return {
        rulesId,
        seed,
        variant,
        ok: false,
        winner: state.winner,
        steps: step,
        failure: {
          kind: "loop-detected",
          step,
          message: `state repeated ${seenCount} times (limit ${repeatLimit}) state=${summarizeState(state)}`,
        },
      };
    }

    if (logEvery > 0 && step % logEvery === 0) {
      console.log(
        `[integration] liveness: ${rulesId} seed=${seed} step=${step} current=${state.currentPlayer ?? "none"}`
      );
    }

    let candidates: ClientIntent[] = [];
    let source = "";
    let currentPlayerCandidates: ClientIntent[] = [];
    try {
      const collected = collectCandidates(state, events);
      candidates = collected.candidates;
      source = collected.source;
      currentPlayerCandidates = collected.currentPlayerCandidates;
    } catch (err) {
      return {
        rulesId,
        seed,
        variant,
        ok: false,
        winner: state.winner,
        steps: step,
        failure: {
          kind: "invariant-failed",
          step,
          message: `list legal intents failed: ${String(err)} state=${summarizeState(state)}`,
        },
      };
    }

    if (state.currentPlayer && currentPlayerCandidates.length === 0) {
      const allCandidates = collectAllCandidates(state, events);
      if (allCandidates.length > 0) {
        return {
          rulesId,
          seed,
          variant,
          ok: false,
          winner: state.winner,
          steps: step,
          failure: {
            kind: "current-player-stuck",
            step,
            message: `current player ${state.currentPlayer} has no legal intents while other players do (${allCandidates.length}) state=${summarizeState(state)}`,
          },
        };
      }
    }

    if (candidates.length === 0) {
      const rulesState =
        state.rulesState && typeof state.rulesState === "object"
          ? (state.rulesState as Record<string, unknown>)
          : {};
      if (rulesState.phase === "ended") {
        return {
          rulesId,
          seed,
          variant,
          ok: true,
          winner: state.winner,
          steps: step,
        };
      }
      return {
        rulesId,
        seed,
        variant,
        ok: false,
        winner: state.winner,
        steps: step,
        failure: {
          kind: "no-legal-intents",
          step,
          message: `no legal intents (${source}) state=${summarizeState(state)}`,
        },
      };
    }

    const offset =
      candidates.length > 1 ? (seenCount - 1) % candidates.length : 0;
    const ranked =
      offset === 0
        ? candidates
        : [...candidates.slice(offset), ...candidates.slice(0, offset)];
    const invalidReasons: string[] = [];
    let advanced = false;

    for (const candidate of ranked) {
      const intent = {
        ...candidate,
        gameId: state.gameId,
      } as ClientIntent;

      let result;
      try {
        result = await validateMove(state, events, intent);
      } catch (err) {
        invalidReasons.push(`throw:${String(err)}`);
        continue;
      }
      if (!result.valid) {
        invalidReasons.push(result.reason ?? "invalid");
        continue;
      }

      assertEngineEventPayloads(
        result.engineEvents,
        `liveness ${rulesId}/${seed}: step ${step}`
      );

      events.push(...result.engineEvents);
      let nextState: GameState;
      try {
        nextState = applyEvents(state, result.engineEvents);
      } catch (err) {
        return {
          rulesId,
          seed,
          variant,
          ok: false,
          winner: state.winner,
          steps: step,
          failure: {
            kind: "apply-events-failed",
            step,
            message: `apply events failed: ${String(err)} intent=${JSON.stringify(intent)} state=${summarizeState(state)}`,
          },
        };
      }

      state = nextState;

      try {
        assertCardConservation(
          state,
          `liveness ${rulesId}/${seed}: step ${step}`
        );
      } catch (err) {
        return {
          rulesId,
          seed,
          variant,
          ok: false,
          winner: state.winner,
          steps: step,
          failure: {
            kind: "invariant-failed",
            step,
            message: `${String(err)} state=${summarizeState(state)}`,
          },
        };
      }

      advanced = true;
      break;
    }

    if (!advanced) {
      return {
        rulesId,
        seed,
        variant,
        ok: false,
        winner: state.winner,
        steps: step,
        failure: {
          kind: "no-valid-legal-intent",
          step,
          message: `all legal intents were invalid (${invalidReasons.slice(0, 3).join(" | ")}) state=${summarizeState(state)}`,
        },
      };
    }
  }

  return {
    rulesId,
    seed,
    variant,
    ok: true,
    winner: state.winner,
    steps: maxMoves,
  };
}

function parseRuleFilterFromArgsAndEnv(): string[] {
  const argRules = process.argv
    .slice(2)
    .map((value) => value.trim())
    .filter(Boolean);
  if (argRules.length > 0) return argRules;

  const envRaw = process.env.LIVENESS_RULES?.trim();
  if (!envRaw) return Object.keys(GAME_PLUGINS).sort();
  return envRaw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
}

async function main() {
  const rulesIds = parseRuleFilterFromArgsAndEnv();
  const variantStart = Math.max(
    0,
    parseIntegerEnv("LIVENESS_VARIANT_START", 0)
  );
  const variants = Math.max(1, parseIntegerEnv("LIVENESS_VARIANTS", 12));
  const maxMoves = Math.max(50, parseIntegerEnv("LIVENESS_MAX_MOVES", 2200));
  const repeatLimit = Math.max(2, parseIntegerEnv("LIVENESS_REPEAT_LIMIT", 12));
  const logEvery = Math.max(0, parseIntegerEnv("LIVENESS_LOG_EVERY", 0));
  const failFast = process.env.LIVENESS_FAIL_FAST === "1";

  const failures: LivenessRunResult[] = [];
  let successCount = 0;
  let totalRuns = 0;

  for (const rulesId of rulesIds) {
    if (!GAME_PLUGINS[rulesId]) {
      throw new Error(`[integration] liveness: unknown rulesId '${rulesId}'`);
    }
    let rulePass = 0;
    let ruleFail = 0;

    for (
      let variant = variantStart;
      variant < variantStart + variants;
      variant += 1
    ) {
      totalRuns += 1;
      const result = await runSingleVariant(
        rulesId,
        variant,
        maxMoves,
        repeatLimit,
        logEvery
      );
      if (result.ok) {
        successCount += 1;
        rulePass += 1;
      } else {
        ruleFail += 1;
        failures.push(result);
        console.error(
          `[integration] liveness FAIL ${rulesId} seed=${result.seed} variant=${variant} step=${result.failure?.step} kind=${result.failure?.kind} ${result.failure?.message ?? ""}`
        );
        if (failFast) {
          throw new Error("[integration] liveness fail-fast triggered");
        }
      }
    }

    console.log(
      `[integration] liveness ${rulesId}: ${rulePass}/${rulePass + ruleFail} seeds passed`
    );
  }

  console.log(
    `[integration] liveness summary: ${successCount}/${totalRuns} runs passed`
  );

  if (failures.length > 0) {
    console.error("[integration] liveness reproduction commands:");
    for (const failure of failures) {
      console.error(
        `  LIVENESS_RULES=${failure.rulesId} LIVENESS_VARIANT_START=${failure.variant} LIVENESS_VARIANTS=1 npm run test:integration:liveness`
      );
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[integration] liveness failed: ${msg}`);
  process.exitCode = 1;
});
