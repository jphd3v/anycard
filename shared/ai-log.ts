export type AiLogPhase =
  | "schedule"
  | "candidates"
  | "llm"
  | "llm-raw"
  | "llm-parsed"
  | "fallback"
  | "execution"
  | "game"
  | "error";

export interface AiLogEntry {
  gameId: string;
  turnNumber: number;
  playerId: string;
  phase: AiLogPhase;
  level: "info" | "warn" | "error";
  message: string;
  // Optional source to distinguish between backend and frontend AI logs
  source?: "backend" | "frontend";
  // Optional structured details we can pretty-print in UI
  details?: unknown;
  timestamp?: string; // ISO string
}
