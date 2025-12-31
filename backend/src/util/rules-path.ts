import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function firstExisting(paths: string[]): string {
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return paths[0];
}

/**
 * Resolve the on-disk location of the `rules` directory.
 * Two simple fallbacks:
 * - dev (source): ../../rules from backend/src/*
 * - build output: ../.. rules from dist/backend/src/*
 */
export function resolveRulesDir(currentDir?: string): string {
  const baseDir = currentDir ?? path.dirname(fileURLToPath(import.meta.url));
  const distRules = path.resolve(baseDir, "..", "..", "rules");
  const sourceRules = path.resolve(baseDir, "..", "..", "..", "rules");
  const candidates =
    process.env.NODE_ENV === "production"
      ? [distRules, sourceRules]
      : [sourceRules, distRules];

  return firstExisting(candidates);
}
