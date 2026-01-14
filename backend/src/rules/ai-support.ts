// backend/src/rules/ai-support.ts
// Plugin interface for AI support (Phase 2 of AI refactor)

import type {
  AiView,
  AiContext,
  AiCandidate,
} from "../../../shared/src/ai/types.js";
import type { GameState, ClientIntent } from "../../../shared/schemas.js";

/**
 * Audience for candidate listing.
 * - "human": Show only single-move atomic candidates (UI friendly)
 * - "ai": May include multi-move macro candidates to reduce candidate count
 */
export type CandidateAudience = "human" | "ai";

/**
 * Plugin interface for AI support.
 *
 * All methods MUST operate only on seat-hardened views (no raw state access for AI).
 * This ensures no information leakage to AI players.
 */
export interface AiSupport {
  /**
   * List available move candidates for the given seat.
   *
   * MUST operate only on the seat-hardened AiView (no raw state access).
   *
   * @param view Seat-hardened view of the game state
   * @param audience "human" = atomic moves only; "ai" = may include multi-move macros
   * @returns List of candidate moves with unique IDs
   *
   * REQUIREMENTS:
   * - All candidate IDs must be unique
   * - Candidates should be deterministically ordered
   * - Summary MUST NOT leak hidden information
   * - For audience="ai", may include macro candidates like "ai:macro:follow-suit-lowest"
   */
  listCandidates(view: AiView, audience: CandidateAudience): AiCandidate[];

  /**
   * Build context (recap + facts) for AI decision making.
   *
   * MUST be derived from AiView only (or a seat-specific log that never contained hidden info).
   *
   * NOTE: rulesMarkdown is handled automatically by the engine and should NOT be included here.
   *
   * @param view Seat-hardened view of the game state
   * @returns Context with recap (string[]) and optional facts
   *
   * REQUIREMENTS:
   * - recap must be deterministic and bounded (e.g., last 30-80 items)
   * - recap must not leak hidden information for other seats
   * - facts must be deterministic (no strategy, no heuristics)
   */
  buildContext?(view: AiView): AiContext;

  /**
   * Apply a chosen candidate ID to the game state.
   *
   * Candidate ID may represent a multi-move macro (e.g., "ai:macro:play-lowest-follow-suit").
   * The plugin is responsible for executing all moves atomically.
   *
   * @param state Current game state
   * @param seat Seat ID making the move
   * @param candidateId The chosen candidate ID (from listCandidates)
   * @returns The intent(s) to execute
   *
   * REQUIREMENTS:
   * - Must validate candidateId is legal for this seat
   * - For multi-move candidates, return array of intents
   * - For single-move candidates, return single intent
   * - Must be deterministic
   */
  applyCandidateId(
    state: GameState,
    seat: string,
    candidateId: string
  ): ClientIntent | ClientIntent[];
}

/**
 * Helper to check if a candidate ID represents a multi-move macro.
 */
export function isMultiMoveCandidate(candidateId: string): boolean {
  return candidateId.startsWith("ai:macro:");
}

/**
 * Helper to sort candidates deterministically (lexicographic by ID).
 */
export function sortCandidatesDeterministically(
  candidates: AiCandidate[]
): AiCandidate[] {
  return [...candidates].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Helper to validate candidate ID uniqueness.
 */
export function validateCandidateUniqueness(candidates: AiCandidate[]): void {
  const ids = new Set<string>();
  const duplicates: string[] = [];

  for (const candidate of candidates) {
    if (ids.has(candidate.id)) {
      duplicates.push(candidate.id);
    }
    ids.add(candidate.id);
  }

  if (duplicates.length > 0) {
    throw new Error(`Duplicate candidate IDs found: ${duplicates.join(", ")}`);
  }
}
