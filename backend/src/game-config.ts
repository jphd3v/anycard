import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GameState, GameLayout } from "../../shared/schemas.js";
import { GameStateSchema, GameLayoutSchema } from "../../shared/schemas.js";
import { applyShuffleToState } from "./shuffler.js";
import { loadGameMeta } from "./rules/meta.js";
import { resolveRulesDir } from "./util/rules-path.js";
import { GAME_PLUGINS } from "./rules/registry.js";

// Get the project root directory (two levels up from this file)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RULES_DIR = resolveRulesDir(__dirname);

function validateRulesId(rulesId: string) {
  // First check format - only allow alphanumeric and hyphens
  if (!/^[a-z0-9-]+$/.test(rulesId)) {
    throw new Error(`Invalid rulesId format: ${rulesId}`);
  }

  // Then check if the rulesId is known
  if (!GAME_PLUGINS[rulesId]) {
    throw new Error(`Unknown rulesId: ${rulesId}`);
  }
}

export function loadInitialState(
  rulesId: string,
  configPath?: string
): GameState {
  validateRulesId(rulesId);

  const resolvedPath = configPath
    ? path.resolve(configPath)
    : path.resolve(RULES_DIR, rulesId, `${rulesId}.initial-state.json`);

  // Path traversal protection - ensure the resolved path is within RULES_DIR
  const rulesRoot = path.resolve(RULES_DIR) + path.sep;
  if (!resolvedPath.startsWith(rulesRoot)) {
    throw new Error("Refusing to load initial state outside RULES_DIR");
  }

  const raw = fs.readFileSync(resolvedPath, "utf8");
  const json = JSON.parse(raw);
  const meta = loadGameMeta(rulesId);
  const withDefaults = {
    ...json,
    gameId: json.gameId ?? "__TEMPLATE__",
    rulesId,
    gameName: json.gameName ?? meta.gameName,
    players: Array.isArray(json.players)
      ? json.players.map((player: Record<string, unknown>) => ({
          ...player,
          aiRuntime:
            player.aiRuntime ??
            (player.isAi ? ("backend" as const) : ("none" as const)),
          aiSponsorConnectionId:
            player.aiSponsorConnectionId !== undefined
              ? player.aiSponsorConnectionId
              : null,
        }))
      : [],
  };
  const parsed = GameStateSchema.parse(withDefaults);
  return parsed;
}

export function loadLayout(rulesId: string, configPath?: string): GameLayout {
  validateRulesId(rulesId);

  const resolvedPath = configPath
    ? path.resolve(configPath)
    : path.resolve(RULES_DIR, rulesId, `${rulesId}.layout.json`);

  // Path traversal protection - ensure the resolved path is within RULES_DIR
  const rulesRoot = path.resolve(RULES_DIR) + path.sep;
  if (!resolvedPath.startsWith(rulesRoot)) {
    throw new Error("Refusing to load layout outside RULES_DIR");
  }

  const raw = fs.readFileSync(resolvedPath, "utf8");
  const parsed = GameLayoutSchema.parse(JSON.parse(raw));
  return parsed;
}

// Update signature to accept seed
export function loadAndValidateGameConfig(
  rulesId: string,
  seed?: string
): GameState {
  const initialState = loadInitialState(rulesId);

  let layout: GameLayout;

  try {
    layout = loadLayout(rulesId);
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;

    if (code === "ENOENT") {
      throw new Error(
        `Layout file not found for rulesId ${rulesId}. Layout JSON must exist and validate against GameLayoutSchema.`
      );
    }

    throw new Error(
      `Layout validation failed for rulesId ${rulesId}: ${details}`
    );
  }

  // Collect all pile IDs from initial state
  const initialStatePileIds = new Set(Object.keys(initialState.piles));

  // Collect all pile IDs referenced in layout
  const layoutPileIds = new Set<string>();
  for (const zone of layout.zones ?? []) {
    for (const pileId of zone.piles ?? []) {
      layoutPileIds.add(pileId);
    }
  }

  // Check if any layout pile IDs are missing from initial state
  const missingPileIds: string[] = [];
  for (const pileId of layoutPileIds) {
    if (!initialStatePileIds.has(pileId)) {
      missingPileIds.push(pileId);
    }
  }

  if (missingPileIds.length > 0) {
    const message = `Layout refers to piles [${missingPileIds.join(
      ", "
    )}] which are not defined in initial-state.piles`;

    if (process.env.NODE_ENV === "production") {
      console.error(message);
      // In production, we log an error and return the initial state without failing
      // Apply shuffle before returning
      return applyShuffleToState(initialState, seed);
    } else {
      // In development, throw an error to fail fast
      throw new Error(message);
    }
  }

  // Apply shuffle before returning
  return applyShuffleToState(initialState, seed);
}

export function loadRulesForGame(rulesId: string): string {
  validateRulesId(rulesId);

  const gameRulesPath = path.resolve(RULES_DIR, rulesId, `${rulesId}.rules.md`);

  // Path traversal protection - ensure the resolved path is within RULES_DIR
  const rulesRoot = path.resolve(RULES_DIR) + path.sep;
  if (!gameRulesPath.startsWith(rulesRoot)) {
    throw new Error("Refusing to load rules outside RULES_DIR");
  }

  return fs.readFileSync(gameRulesPath, "utf8");
}
