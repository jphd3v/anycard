import type {
  ClientIntent,
  GameState,
  Scoreboard,
} from "../../../shared/schemas.js";
import type { ValidationResult } from "../../../shared/validation.js";
import type { ValidationState } from "../validation-state.js";

export interface ValidationHints {
  /**
   * Pile IDs whose full card contents should always be visible to the rules / LLM,
   * regardless of pile.visibility.
   */
  sharedPileIds?: string[];

  /**
   * Optional callback to decide whether a pile should be treated as “always fully visible”
   * to the rules, even if not strictly public. This is called in addition to sharedPileIds.
   */
  isPileAlwaysVisibleToRules?: (pileId: string) => boolean;

  /**
   * Optional callback that returns a lookup of cardId -> playerId for the current GameState.
   * This is used to populate ValidationPileSummary.cards[].playedBy for LLM use.
   */
  buildPlayedByLookup?: (state: GameState) => Map<number, string | null>;
}

/**
 * Canonical, deterministic rule engine for a game.
 *
 * - Implemented in TypeScript.
 * - Operates on ValidationState (pre-move snapshot + recent events).
 * - Must be pure and deterministic: same input => same ValidationResult.
 *
 * Temporal model:
 * - The player's move has NOT been applied yet.
 * - ValidationState reflects the current game plus a simplified event window.
 */
export interface GameRuleModule {
  /**
   * Validates a move and determines its consequences deterministically.
   *
   * Temporal model:
   * - The player's move has not yet been applied to the engine state.
   * - `ValidationState` is a pre-move snapshot.
   * - Rule engines (LLM or code) may either:
   *   - Accept the move and emit engineEvents, or
   *   - Reject it with `valid: false` and a reason.
   */
  validate(state: ValidationState, intent: ClientIntent): ValidationResult;

  /**
   * Optional: return a list of legal client intents for the given player
   * in the current state.
   *
   * This is used by AI players as the primary source of move candidates.
   *
   * - It MUST only return intents that would be accepted by `validate(...)`.
   * - It SHOULD reflect phase-specific constraints (e.g. "must draw", "must discard").
   * - It SHOULD be deterministic for a given state and player.
   */
  listLegalIntentsForPlayer?(
    state: ValidationState,
    playerId: string
  ): ClientIntent[];

  /**
   * Optional: derive scoreboards specifically for the given viewer.
   *
   * Use this when some scoreboard cells depend on private information (e.g. a player's hand).
   * The returned scoreboards MUST NOT leak hidden information to other players/spectators.
   *
   * viewerId will sometimes be:
   * - a real seat/player id (normal player view)
   * - "__spectator__" (spectator view)
   * - "__god__" (god-mode spectator view; may see everything)
   */
  deriveScoreboardsForView?(
    gameState: GameState,
    viewerId: string
  ): Scoreboard[];
}

export interface GamePlugin {
  /** Stable identifier for the game, e.g. "durak", "bridge". */
  id: string;
  /** Human-readable name for UIs (e.g. lobby). */
  gameName: string;
  /** Code-based rule engine for this game. */
  ruleModule: GameRuleModule;
  /** Optional short description for future use. */
  description?: string;

  /**
   * Optional hints that customize how ValidationState is built for this game.
   */
  validationHints?: ValidationHints;
}
