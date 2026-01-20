import type {
  ClientIntent,
  GameState,
  GameEvent,
} from "../../shared/schemas.js";
import type { ValidationResult } from "../../shared/validation.js";
import { buildValidationState } from "./validation-state.js";
import { GAME_PLUGINS } from "./rules/registry.js";
import { projectState, getEvents } from "./state.js";

const envRuleEngineModeRaw = process.env.RULE_ENGINE_MODE;
if (envRuleEngineModeRaw && envRuleEngineModeRaw !== "code") {
  console.warn(
    `[rule-engine] RULE_ENGINE_MODE="${envRuleEngineModeRaw}" is no longer supported; running in "code" mode only.`
  );
}

export const RULE_ENGINE_MODE = "code" as const;

function buildValidationStateForPlayer(
  gameState: GameState,
  events: GameEvent[],
  playerId: string
) {
  const dummyIntent: ClientIntent = {
    type: "action",
    gameId: gameState.gameId,
    playerId,
    action: "dummy",
  };
  return buildValidationState(gameState, events, dummyIntent);
}

export async function validateMove(
  state: GameState,
  events: GameEvent[],
  intent: ClientIntent
): Promise<ValidationResult> {
  // Build a single ValidationState from the pre-move state + current event log
  const validationState = buildValidationState(state, events, intent);

  const plugin = GAME_PLUGINS[state.rulesId];
  if (!plugin) {
    return {
      valid: false,
      reason: `System Error: No plugin registered for rulesId="${state.rulesId}"`,
      engineEvents: [],
    };
  }

  try {
    return plugin.ruleModule.validate(validationState, intent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Rule execution failed for ${state.rulesId}: ${msg}`);
    return {
      valid: false,
      reason: `Internal Rule Error (${state.rulesId}): ${msg}`,
      engineEvents: [],
    };
  }
}

export function listLegalIntentsForPlayer(
  gameId: string,
  playerId: string
): ClientIntent[] {
  const gameState = projectState(gameId);
  if (!gameState) return [];

  const events = getEvents(gameId);
  const plugin = GAME_PLUGINS[gameState.rulesId];
  if (!plugin || !plugin.ruleModule.listLegalIntentsForPlayer) return [];

  const validationState = buildValidationStateForPlayer(
    gameState,
    events,
    playerId
  );

  return (
    plugin.ruleModule.listLegalIntentsForPlayer!(validationState, playerId) ??
    []
  );
}

export function listLegalIntentsForView(
  gameId: string,
  playerId: string
): ClientIntent[] {
  const gameState = projectState(gameId);
  if (!gameState) return [];

  const events = getEvents(gameId);
  const plugin = GAME_PLUGINS[gameState.rulesId];
  const listForView =
    plugin?.ruleModule.listLegalIntentsForView ??
    plugin?.ruleModule.listLegalIntentsForPlayer;

  if (!listForView) return [];

  const validationState = buildValidationStateForPlayer(
    gameState,
    events,
    playerId
  );

  return listForView.call(plugin.ruleModule, validationState, playerId) ?? [];
}
