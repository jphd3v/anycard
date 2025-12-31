// backend/src/ai/ai-scheduler.ts

import type { EngineEvent } from "../../../shared/validation.js";
import type { LastAction } from "../../../shared/schemas.js";
import { projectState } from "../state.js";
import { runAiTurn } from "./ai-turn.js";
import { isServerAiEnabled } from "../config.js";

// Track which games currently have an AI move in progress to avoid double scheduling.
const aiInFlight = new Set<string>(); // gameId

// If scheduling is requested while an AI turn is already in flight, remember it and
// re-attempt scheduling once the in-flight turn completes. This prevents AI→AI
// handoffs from getting stuck when the next-turn scheduler fires during an async
// wait inside the current AI turn.
const pendingReschedule = new Map<
  string,
  {
    broadcastStateCallback?: (
      gameId: string,
      lastEngineEvents?: EngineEvent[],
      lastAction?: LastAction
    ) => void;
    requestedAtMs: number;
  }
>(); // gameId -> pending scheduling request

type SeatRuntime = "none" | "backend" | "frontend";

function resolveSeatRuntime(seat: {
  aiRuntime?: SeatRuntime;
  isAi?: boolean;
}): SeatRuntime {
  return seat.aiRuntime ?? (seat.isAi ? "backend" : "none");
}

function areAllSeatsAutomated(game: {
  players: Array<{ aiRuntime?: SeatRuntime; isAi?: boolean }>;
}): boolean {
  return (
    game.players.length > 0 &&
    game.players.every((seat) => resolveSeatRuntime(seat) !== "none")
  );
}

function requestRescheduleAfterInFlight(
  gameId: string,
  broadcastStateCallback?: (
    gameId: string,
    lastEngineEvents?: EngineEvent[],
    lastAction?: LastAction
  ) => void
): void {
  pendingReschedule.set(gameId, {
    broadcastStateCallback,
    requestedAtMs: Date.now(),
  });
}

function maybeRunPendingReschedule(gameId: string): void {
  const pending = pendingReschedule.get(gameId);
  if (!pending) return;

  // Clear first to avoid loops if scheduling immediately re-requests.
  pendingReschedule.delete(gameId);
  maybeScheduleAiTurn(gameId, pending.broadcastStateCallback);
}

export async function forceRunAiTurnOnce(
  gameId: string,
  playerId: string,
  broadcastStateCallback?: (
    gameId: string,
    events?: EngineEvent[],
    lastAction?: LastAction
  ) => void
) {
  if (aiInFlight.has(gameId)) {
    return;
  }

  aiInFlight.add(gameId);
  try {
    await runAiTurn(gameId, playerId, broadcastStateCallback);
  } finally {
    aiInFlight.delete(gameId);
    maybeRunPendingReschedule(gameId);
  }
}

export function maybeScheduleAiTurn(
  gameId: string,
  broadcastStateCallback?: (
    gameId: string,
    lastEngineEvents?: EngineEvent[],
    lastAction?: LastAction
  ) => void
): void {
  if (!isServerAiEnabled()) {
    return;
  }

  const game = projectState(gameId);

  // Avoid duplicate scheduling
  if (aiInFlight.has(gameId)) {
    requestRescheduleAfterInFlight(gameId, broadcastStateCallback);
    return;
  }
  if (!game) {
    return;
  }

  // For games that use the start-game / hasDealt pattern,
  // do not schedule AI turns before the game has started unless the table is AI-only.
  const rulesState = game.rulesState ?? {};
  const hasDealt = (rulesState as { hasDealt?: boolean }).hasDealt;
  const allSeatsAutomated = areAllSeatsAutomated(game);
  if (
    typeof hasDealt === "boolean" &&
    hasDealt === false &&
    !allSeatsAutomated
  ) {
    return;
  }

  // Use whatever you already have to determine current player.
  let currentPlayerId = game.currentPlayer; // adapt to your actual field
  if (!currentPlayerId) {
    if (
      typeof hasDealt === "boolean" &&
      hasDealt === false &&
      allSeatsAutomated
    ) {
      const fallbackSeat = game.players.find(
        (seat) => resolveSeatRuntime(seat) === "backend"
      );
      if (!fallbackSeat) {
        return;
      }
      currentPlayerId = fallbackSeat.id;
    } else {
      return;
    }
  }

  const seat = game.players.find(
    (s: { id: string }) => s.id === currentPlayerId
  );
  if (!seat || seat.aiRuntime !== "backend") {
    return;
  }

  // Optional: check game is not finished
  if (game.winner) {
    return;
  }

  aiInFlight.add(gameId);

  // Use a 0ms timeout just to break call-stack recursion; human-ish delay is handled
  // inside runAiTurn via LLM_MIN_THINK_TIME_MS.
  setTimeout(async () => {
    try {
      await runAiTurn(gameId, currentPlayerId, broadcastStateCallback);
    } finally {
      aiInFlight.delete(gameId);
      maybeRunPendingReschedule(gameId);
    }
  }, 0);
}
