// shared/src/ai/types.ts
// Shared AI request/response shapes used by both backend and frontend.

// One candidate action the AI may choose from.
export interface AiCandidate {
  id: string; // Stable within the current turn (e.g., "action:pass", "move:hand:cardId_3->table")
  summary: string; // Short human-readable description
  intent: unknown; // Concrete intent object understood by the backend
}

// Input to AI policy.
export interface AiRequest {
  rulesId: string;
  seatId: string;
  view: unknown; // Per-seat GameView (replace unknown with shared type when available)
  candidates: AiCandidate[];
  rulesMarkdown?: string;
  agentGuide?: unknown;
}

// AI choice output (from LLM).
export interface AiChoice {
  chosenCandidateId: string;
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
