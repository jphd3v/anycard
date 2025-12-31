import { createHash } from "node:crypto";
import type { GameState } from "../../shared/schemas.js";

export function toViewCardId(
  engineCardId: number,
  viewSalt: string,
  viewerKey: string
): number {
  const hash = createHash("sha256")
    .update(`${viewSalt}|${viewerKey}|${engineCardId}`)
    .digest();

  const id = hash.readUIntBE(0, 6); // 48 bits; safe integer < 2^53
  return 1_000_000 + id;
}

export function resolveEngineCardId(
  viewCardId: number,
  viewSalt: string,
  viewerKey: string,
  state: GameState
): number | null {
  for (const key of Object.keys(state.cards)) {
    const engineCardId = Number(key);
    if (!Number.isInteger(engineCardId)) {
      continue;
    }
    if (toViewCardId(engineCardId, viewSalt, viewerKey) === viewCardId) {
      return engineCardId;
    }
  }
  return null;
}
