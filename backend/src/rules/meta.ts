import fs from "node:fs";
import path from "node:path";
import { resolveRulesDir } from "../util/rules-path.js";

export type GameMeta = {
  rulesId: string;
  gameName: string;
  displayName?: string;
  description?: string;
  minPlayers?: number;
  maxPlayers?: number;
  category?: string;
};

const RULES_DIR = resolveRulesDir();

export function loadGameMeta(rulesId: string): GameMeta {
  const metaPath = path.resolve(RULES_DIR, rulesId, "meta.json");
  try {
    const raw = fs.readFileSync(metaPath, "utf8");
    const parsed = JSON.parse(raw) as GameMeta;
    if (parsed.rulesId && parsed.rulesId !== rulesId) {
      console.warn(
        `[meta] rulesId mismatch in ${metaPath}: expected ${rulesId}, got ${parsed.rulesId}`
      );
    }
    return {
      rulesId,
      gameName:
        parsed.gameName ?? parsed.displayName ?? parsed.rulesId ?? rulesId,
      description: parsed.description,
      minPlayers: parsed.minPlayers,
      maxPlayers: parsed.maxPlayers,
      category: parsed.category,
    };
  } catch (err) {
    console.warn(`[meta] Falling back to defaults for ${rulesId}: ${err}`);
    return {
      rulesId,
      gameName: rulesId,
    };
  }
}
