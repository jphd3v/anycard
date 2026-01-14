// backend/src/rules/impl/template-game.ts

// NOTE: When turning this template into a real game with AI, you MUST implement
// listLegalIntentsForPlayer so the AI subsystem knows what moves are legal.

import type { GameRuleModule } from "../interface.js";
import type { ValidationState } from "../../validation-state.js";
import type { ClientIntent } from "../../../../shared/schemas.js";
import { loadGameMeta } from "../meta.js";

const META = loadGameMeta("template");

export const templateRules: GameRuleModule = {
  validate(state, intent) {
    // TODO: Implement validation for this game.
    // Use projectPilesAfterEvents(state, events) if you need to calculate scores
    // or validate board state BEFORE committing.
    // If your game deals cards, prefer helpers in ../util/dealing.ts when they
    // match the real dealing method; keep custom order if rules require it.

    console.log("Template validation called with:", {
      state: state.rulesId,
      intent: intent.type,
    });
    return {
      valid: false,
      reason: "Not implemented",
      engineEvents: [],
    };
  },

  /**
   * AI support:
   *
   * If this game should be playable by AI seats, implement this method.
   * Return all legal intents for the given player.
   * For AI context/history, implement the AiSupport interface.
   */
  listLegalIntentsForPlayer(
    state: ValidationState,
    playerId: string
  ): ClientIntent[] {
    // RECOMMENDED PATTERN: "Candidate + Filter"
    // 1. Generate logical candidate intents (e.g. all cards in hand to target piles).
    // 2. Filter them by calling this.validate(state, candidate).valid.
    // 3. Return the filtered list.

    console.log("Template listLegalIntentsForPlayer called with:", {
      rulesId: state.rulesId,
      playerId,
    });
    return [];
  },
};

// The plugin registers this game in the registry
export const templatePlugin = {
  id: "template",
  gameName: META.gameName,
  ruleModule: templateRules,
  description: META.description,
};
