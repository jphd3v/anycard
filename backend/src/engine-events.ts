import type { EngineEvent } from "../../shared/validation.js";
import { appendEvent } from "./state.js";
import type { GameEvent, PileLayout } from "../../shared/schemas.js";
import type { LastAction } from "../../shared/schemas.js";

export function emitFatalErrorEvent(
  gameId: string,
  message: string,
  source: "ai" | "rules" | "engine" = "engine",
  broadcastStateCallback?: (
    gameId: string,
    engineEvents?: EngineEvent[],
    lastAction?: LastAction
  ) => void
): void {
  const fatalEvent: GameEvent = {
    id: Date.now(), // Use timestamp as a simple ID
    gameId,
    playerId: null, // No specific player involved
    type: "fatal-error",
    message,
    source,
  };

  // Persist event like any other game event
  appendEvent(gameId, fatalEvent);

  // Optionally log
  console.error(`[FATAL] Game ${gameId}: ${source} - ${message}`);

  // Broadcast to clients so UI can react immediately
  if (broadcastStateCallback) {
    // Convert to EngineEvent for broadcast (which is a subset without the ID)
    const engineEvent: EngineEvent = {
      type: "fatal-error",
      message,
      source,
    };
    broadcastStateCallback(gameId, [engineEvent]);
  }
}

export function emitSetPilePropertiesEvent(
  gameId: string,
  properties: Record<string, { layout?: PileLayout; label?: string }>,
  appendEventCallback: (gameId: string, event: GameEvent) => void
): void {
  const event: GameEvent = {
    id: Date.now(),
    gameId,
    playerId: null,
    type: "set-pile-properties",
    properties,
  };

  appendEventCallback(gameId, event);
}
