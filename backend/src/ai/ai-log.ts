import type { AiLogEntry } from "../../../shared/ai-log.js";
import type { Server as SocketIOServer } from "socket.io";
import { getEnvironmentConfig } from "../config.js";

export type { AiLogEntry } from "../../../shared/ai-log.js";

const aiLogsByGame = new Map<string, AiLogEntry[]>();

// Call this once with your socket.io server instance or a wrapper
let io: SocketIOServer | null = null;
export function initAiLogIo(server: SocketIOServer) {
  io = server;
}

export function appendAiLogEntry(entry: AiLogEntry): void {
  const { llmShowPromptsInFrontend } = getEnvironmentConfig();

  // Determine if this entry should be stored and broadcast.
  // Game events (moves/actions) are always allowed.
  // Frontend-originated logs are always allowed (the AI runs in the browser).
  // Backend technical logs (prompts/responses) are filtered by LLM_SHOW_PROMPTS_IN_FRONTEND.
  const isGameEvent = entry.phase === "game";
  const isFrontend = entry.source === "frontend";
  const allowBackendTechnical = llmShowPromptsInFrontend;

  if (!isGameEvent && !isFrontend && !allowBackendTechnical) {
    return;
  }

  const fullEntry: AiLogEntry = {
    ...entry,
    timestamp: entry.timestamp ?? new Date().toISOString(),
  };

  const list = aiLogsByGame.get(entry.gameId) ?? [];
  list.push(fullEntry);
  aiLogsByGame.set(entry.gameId, list);

  // Emit to all clients in that game room if io is available
  if (io) {
    io.to(entry.gameId).emit("game:ai-log", {
      gameId: entry.gameId,
      entries: [fullEntry],
    });
  }
}

/**
 * Broadcasts a simple status toast to all clients in a game.
 */
export function sendGameStatus(
  gameId: string,
  message: string,
  tone: "info" | "success" | "warning" | "error" = "info",
  source: "ai" | "rules" | "engine" | "app" = "app"
) {
  if (io) {
    io.to(gameId).emit("game:status", {
      message,
      tone,
      source,
    });
  }
}

// Optional: to replay when a client joins
export function getAiLog(gameId: string): AiLogEntry[] {
  return aiLogsByGame.get(gameId) ?? [];
}

export function clearAiLogForGame(gameId: string): void {
  aiLogsByGame.delete(gameId);
}
