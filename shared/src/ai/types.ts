// shared/src/ai/types.ts
// Shared AI request/response shapes used by both backend and frontend.

/**
 * Seat-hardened view of the game state for AI.
 * Engine guarantees no information leakage.
 */
export interface AiView {
  seat: string; // The seat ID this view is for
  public: unknown; // Safe for everyone
  private: unknown; // Safe for this seat only
}

/**
 * Context provided to AI (deterministic, bounded, seat-safe).
 * Recap is stored in rulesState and returned via buildContext().
 */
export interface AiContext {
  recap?: string[]; // Game history summaries from rulesState.recap (oldest → newest)
  facts?: Record<string, unknown>; // Optional plugin-defined deterministic extra facts (still non-secret)
}

/**
 * One candidate move the AI may choose from.
 * Candidate IDs are the ONLY IDs the LLM may return.
 * May represent multi-move macros (AI-only).
 */
export interface AiCandidate {
  id: string; // The ONLY id the LLM may return (e.g., "play:c17", "ai:macro:follow-suit-lowest")
  summary?: string; // Optional label; MUST NOT leak hidden info
}

/**
 * Input to AI turn (clean, minimal schema).
 */
export interface AiTurnInput {
  view: AiView;
  context?: AiContext;
  candidates: AiCandidate[];
  rulesMarkdown: string; // Rules text for the game
}

/**
 * AI turn output (from LLM).
 * MUST contain exactly one id from candidates[].id.
 */
export interface AiTurnOutput {
  id: string;
}

export type AiErrorType = "timeout" | "policy" | "validation" | "unexpected";

export class AiError extends Error {
  type: AiErrorType;
  details?: string;

  constructor(type: AiErrorType, message: string, details?: string) {
    super(message);
    this.name = "AiError";
    this.type = type;
    this.details = details;
  }
}
