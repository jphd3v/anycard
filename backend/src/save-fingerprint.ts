import type { GameState, GameSaveFormat } from "../../shared/schemas.js";
import {
  GAME_SAVE_EVENT_PAYLOAD_SCHEMA_HASH,
  GAME_SAVE_HASH_ALGORITHM,
  GAME_SAVE_SCHEMA_HASH,
  hashDescriptorForSave,
} from "../../shared/schemas.js";

function deriveRulesSchemaDescriptor(initialState: GameState): unknown {
  const playerIds = initialState.players.map((player) => player.id);
  const pileShape = Object.values(initialState.piles)
    .map((pile) => ({
      id: pile.id,
      ownerId: pile.ownerId,
      visibility: pile.visibility,
      hasShuffle: Boolean(pile.shuffle),
      shuffleGroup: pile.shuffleGroup ?? null,
      allowReorder: Boolean(pile.allowReorder),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const rulesStateKeys =
    initialState.rulesState &&
    typeof initialState.rulesState === "object" &&
    !Array.isArray(initialState.rulesState)
      ? Object.keys(initialState.rulesState as Record<string, unknown>).sort()
      : [];

  return {
    rulesId: initialState.rulesId,
    gameName: initialState.gameName,
    playerIds,
    pileShape,
    rulesStateKeys,
  };
}

export function computeRulesSchemaHash(initialState: GameState): string {
  return hashDescriptorForSave(deriveRulesSchemaDescriptor(initialState));
}

export function buildGameSaveFormat(initialState: GameState): GameSaveFormat {
  return {
    hashAlgorithm: GAME_SAVE_HASH_ALGORITHM,
    saveSchemaHash: GAME_SAVE_SCHEMA_HASH,
    eventPayloadSchemaHash: GAME_SAVE_EVENT_PAYLOAD_SCHEMA_HASH,
    rulesSchemaHash: computeRulesSchemaHash(initialState),
  };
}
