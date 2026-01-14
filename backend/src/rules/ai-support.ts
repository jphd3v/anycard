// backend/src/rules/ai-support.ts
// Plugin interface for AI context (recap + facts)

import type { AiView, AiContext } from "../../../shared/src/ai/types.js";

/**
 * Plugin interface for AI context enrichment.
 *
 * The AI receives two types of information:
 * 1. **Candidates** from `listLegalIntentsForPlayer` (required) → what moves are legal
 * 2. **Context** from `buildContext` (strongly encouraged) → game history and state
 *
 * Without context, the AI only sees the current board and legal moves—no memory
 * of what happened. For good AI play, games SHOULD implement `buildContext`.
 *
 * All methods MUST operate only on seat-hardened views (no raw state access).
 * This ensures no information leakage to AI players.
 */
export interface AiSupport {
  /**
   * Build context (recap + facts) for AI decision making.
   *
   * **Why recap matters:** Card games involve tracking information over time—
   * what cards were played, who won which tricks, what was discarded. Without
   * this history, the AI plays "blind" and makes poor decisions.
   *
   * **The pattern:**
   * 1. Store `recap: string[]` in your `rulesState` (persists across turns)
   * 2. Update it during `validate()` as meaningful events occur
   * 3. Expose it here via `buildContext()`
   *
   * @param view Seat-hardened view of the game state
   * @returns Context with recap (string[]) and optional facts
   *
   * ## Best Practices
   *
   * - Keep entries concise (1 line each)
   * - Track meaningful events, not every atomic action
   * - Collapse details to summaries at natural boundaries (hand end, round end)
   * - Bound the array (e.g., last 50-80 entries) to prevent unbounded growth
   * - Never leak hidden information from other seats
   *
   * ## Examples by Game Type
   *
   * **Trick-taking (Bridge, Katko):**
   * - Per trick: "Trick 3: P1 K♠️, P2 7♠️ → P1 wins"
   * - At hand end: "Hand 2: P1 won. Scores: P1=2, P2=1"
   *
   * **Rummy-style (Canasta, Gin Rummy):**
   * - Per turn: "P2: drew from stock, melded 3 cards, discarded K♠️"
   * - At hand end: "Hand 1: P3 went out. Scores: A=150, B=-50"
   *
   * ## Facts
   *
   * Optional structured data about current state:
   * - Good: `{ trumpSuit: "spades", mustFollowSuit: true, leadSuit: "hearts" }`
   * - Bad: `{ preferLowCards: true }` ❌ (strategy hints)
   *
   * **Reference:** See bridge.ts for a complete implementation.
   */
  buildContext?(view: AiView): AiContext;
}
