// backend/src/intent-handler.ts

import {
  appendEvent,
  applyEvent,
  getEvents,
  getHumanTurnNumber,
  getViewSalt,
  projectState,
  trimFinishedGamesNow,
} from "./state.js";
import { validateMove } from "./rule-engine.js";
import {
  GameEventSchema,
  ClientIntent,
  MoveIntent,
  GameState,
  GameEvent,
  LastAction,
} from "../../shared/schemas.js";
import type { EngineEvent } from "../../shared/validation.js";
import { maybeScheduleAiTurn } from "./ai/ai-scheduler.js";
import { resolveEngineCardId } from "./view-ids.js";
import { getSuitSymbol } from "./util/card-notation.js";
import { isPileVisibleToPlayer } from "./visibility.js";
import { appendAiLogEntry } from "./ai/ai-log.js";

/**
 * Normalize a MoveIntent to always return an array of card IDs.
 * This helper ensures uniform handling of both single and multi-card moves.
 * PRECONDITION: Either cardId or cardIds must be defined (enforced by engine validation).
 */
export function normalizeCardIds(intent: MoveIntent): number[] {
  if (intent.cardId !== undefined) {
    return [intent.cardId];
  }
  if (intent.cardIds !== undefined) {
    return intent.cardIds;
  }
  // This should never happen after engine-level validation
  console.error("normalizeCardIds called with invalid intent:", intent);
  throw new Error(
    "normalizeCardIds called with intent missing both cardId and cardIds"
  );
}

type SeatRuntime = "none" | "backend" | "frontend";

function resolveSeatRuntime(seat: {
  aiRuntime?: SeatRuntime;
  isAi?: boolean;
}): SeatRuntime {
  return seat.aiRuntime ?? (seat.isAi ? "backend" : "none");
}

function areAllSeatsAutomated(state: GameState): boolean {
  return (
    state.players.length > 0 &&
    state.players.every((seat) => resolveSeatRuntime(seat) !== "none")
  );
}

function findMoveLabel(
  state: GameState,
  intent: ClientIntent,
  viewerId?: string
): string {
  if (intent.type !== "move") return "Move Card";
  const cardIds = normalizeCardIds(intent);
  if (cardIds.length === 0) return "Move Card";

  // For multi-card moves, show count or first card
  if (cardIds.length > 1) {
    return `Move ${cardIds.length} cards`;
  }

  const card = state.cards[cardIds[0]];
  if (!card) return "Move Card";

  if (viewerId && viewerId !== "__god__") {
    const fromPile = state.piles[intent.fromPileId];
    const toPile = state.piles[intent.toPileId];
    const visibleBefore = fromPile
      ? isPileVisibleToPlayer(fromPile, viewerId)
      : false;
    const visibleAfter = toPile
      ? isPileVisibleToPlayer(toPile, viewerId)
      : false;

    if (!visibleBefore && !visibleAfter) {
      if (intent.toPileId.includes("hand") || intent.fromPileId === "deck") {
        return "Draw Card";
      }
      return "Move Card";
    }
  }

  const cardLabel = card.label || `${card.rank}${getSuitSymbol(card.suit)}`;
  return cardLabel;
}

function findActionLabel(
  state: GameState,
  actionId: string
): string | undefined {
  return state.actions?.cells?.find((cell) => cell.id === actionId)?.label;
}

function appendGameLogIntent(
  state: GameState,
  intent: ClientIntent,
  turnNumber: number
): void {
  let label =
    intent.type === "action"
      ? (findActionLabel(state, intent.action) ?? intent.action)
      : findMoveLabel(state, intent, "__spectator__");
  let prefix = intent.type === "action" ? "Action" : "Move";

  if (intent.type === "action" && intent.action === "start-game") {
    prefix = "SETUP";
    // If we have a rulesState and it's not the first deal, call it Next Round
    const rs = state.rulesState as { dealNumber?: number } | null;
    if (rs && typeof rs.dealNumber === "number" && rs.dealNumber > 0) {
      label = "Next Round";
    }
  }

  appendAiLogEntry({
    gameId: state.gameId,
    turnNumber,
    playerId: intent.playerId,
    phase: "game",
    level: "info",
    message: `${prefix}: ${label}`,
    details: {
      kind: "game-intent",
      intentType: intent.type,
      label,
      ...(intent.type === "action"
        ? { actionId: intent.action }
        : { fromPileId: intent.fromPileId, toPileId: intent.toPileId }),
    },
  });
}

export interface ShortCircuitResult {
  shortCircuit: boolean;
  reason?: string;
}

// Local pre-validation to reject obviously invalid intents before calling the rules engine
export function preValidateIntentLocally(
  state: GameState,
  intent: ClientIntent
): ShortCircuitResult {
  // Game over guard: if game already has a winner, reject any further moves
  // Exception: Allow "start-game" action to restart the game
  if (state.winner != null) {
    if (!(intent.type === "action" && intent.action === "start-game")) {
      return {
        shortCircuit: true,
        reason: "Game is already over; no further moves are allowed.",
      };
    }
  }

  // Allow any seated player to kick off the game regardless of turn assignment
  if (intent.type === "action" && intent.action === "start-game") {
    // start-game is always allowed (unless rule engine rejects it later)
  } else {
    // If currentPlayer is not set, it implies the game hasn't started (or is in a state where no one can move)
    if (state.currentPlayer === null) {
      return {
        shortCircuit: true,
        reason: "Game has not started or no active player.",
      };
    }

    // Turn-based guard: if current player is set and doesn't match intent player
    if (state.currentPlayer && intent.playerId !== state.currentPlayer) {
      return {
        shortCircuit: true,
        reason: "It is not your turn.",
      };
    }
  }

  // Only apply move-specific validations to move intents
  if (intent.type === "move") {
    // Card ID specification guard: ensure exactly one of cardId or cardIds is provided
    const hasCardId = intent.cardId !== undefined;
    const hasCardIds =
      intent.cardIds !== undefined &&
      Array.isArray(intent.cardIds) &&
      intent.cardIds.length > 0;
    if (!hasCardId && !hasCardIds) {
      return {
        shortCircuit: true,
        reason: "Must specify either 'cardId' or a non-empty 'cardIds' array.",
      };
    }
    if (hasCardId && hasCardIds) {
      return {
        shortCircuit: true,
        reason: "Cannot specify both 'cardId' and 'cardIds'.",
      };
    }

    // No-op move guard: if moving from the same pile to the same pile
    if (intent.fromPileId === intent.toPileId) {
      return {
        shortCircuit: true,
        reason: "Moving a card within the same pile has no effect.",
      };
    }

    // Card membership guard: verify all cards actually exist in the source pile
    const fromPile = state.piles[intent.fromPileId];
    if (!fromPile) {
      return {
        shortCircuit: true,
        reason: `Pile '${intent.fromPileId}' does not exist.`,
      };
    }

    const cardIds = normalizeCardIds(intent);
    for (const cardId of cardIds) {
      if (!fromPile.cardIds.includes(cardId)) {
        return {
          shortCircuit: true,
          reason: `Card ${cardId} is not in the source pile.`,
        };
      }
    }
  }

  // If we reach here, the intent passed all local pre-validation checks
  return {
    shortCircuit: false,
  };
}

export type BroadcastCallback = (
  gameId: string,
  engineEvents?: EngineEvent[],
  lastAction?: LastAction
) => void;

export interface HandleIntentResult {
  success: boolean;
  engineEvents?: EngineEvent[]; // Engine events that should be broadcast for animations
}

export async function handleClientIntent(
  gameId: string,
  playerId: string,
  intent: ClientIntent,
  broadcastStateCallback?: BroadcastCallback
): Promise<HandleIntentResult> {
  // Returns result with engine events for animations
  console.log("Handling client intent", { gameId, playerId, intent });
  try {
    // This replicates the intent processing logic from socket.ts
    const state = projectState(gameId);
    if (!state) {
      console.error(`Game ${gameId} not found`);
      return { success: false };
    }

    // Check if this is an AI seat attempting to start the game
    const seat = state.players.find((s: { id: string }) => s.id === playerId);
    const isAiSeat = !!seat && resolveSeatRuntime(seat) === "backend";

    if (
      isAiSeat &&
      intent.type === "action" &&
      intent.action === "start-game"
    ) {
      const allSeatsAutomated = areAllSeatsAutomated(state);
      if (!allSeatsAutomated) {
        console.log(
          `Rejecting start-game action from AI seat ${playerId} in game ${gameId}`
        );
        return { success: false };
      }
    }

    const events = getEvents(gameId);
    console.log(
      `Found ${events.length} events for game ${gameId}, current player: ${state.currentPlayer}`
    );

    let intentForEngine: ClientIntent = intent;
    if (intent.type === "move") {
      const viewSalt = getViewSalt(gameId);
      const viewerKey = intent.playerId;

      // Handle both single and multi-card intents
      if (intent.cardId !== undefined) {
        const engineCardId = resolveEngineCardId(
          intent.cardId,
          viewSalt,
          viewerKey,
          state
        );
        if (engineCardId == null) {
          console.log(`Intent rejected: Unknown card`, {
            gameId,
            playerId,
            viewCardId: intent.cardId,
          });
          return { success: false };
        }
        intentForEngine = { ...intent, cardId: engineCardId };
      } else if (intent.cardIds !== undefined) {
        const engineCardIds: number[] = [];
        for (const viewCardId of intent.cardIds) {
          const engineCardId = resolveEngineCardId(
            viewCardId,
            viewSalt,
            viewerKey,
            state
          );
          if (engineCardId == null) {
            console.log(`Intent rejected: Unknown card in cardIds`, {
              gameId,
              playerId,
              viewCardId,
            });
            return { success: false };
          }
          engineCardIds.push(engineCardId);
        }
        intentForEngine = { ...intent, cardIds: engineCardIds };
      }
    }

    // Perform local pre-validation
    const shortCircuit = preValidateIntentLocally(state, intentForEngine);
    if (shortCircuit.shortCircuit) {
      console.log(
        `Intent rejected by local pre-validation: ${shortCircuit.reason}`
      );
      return { success: false };
    }

    // Validate through the rule engine
    console.log(`Sending intent to validation:`, intentForEngine);
    const validation = await validateMove(state, events, intentForEngine);
    console.log(`Validation result:`, {
      valid: validation.valid,
      reason: validation.reason,
    });

    if (!validation.valid) {
      console.log(`Intent rejected by validation: ${validation.reason}`);
      return { success: false };
    }

    const turnNumberForLog = getHumanTurnNumber(gameId);
    // Apply engine events (dealer events)
    let workingState = state;

    const appliedEngineEvents: EngineEvent[] = [];
    for (const ev of validation.engineEvents ?? []) {
      let dealerEvent: GameEvent;
      try {
        dealerEvent = GameEventSchema.parse({
          id: Date.now(),
          gameId: intent.gameId,
          playerId: null,
          ...ev,
        });
      } catch (error) {
        console.warn(`Engine ignored invalid engine event: ${error}`);
        continue;
      }

      // Apply the dealer event to the state
      const appliedState = applyEvent(workingState, dealerEvent);
      workingState = appliedState;
      appendEvent(intent.gameId, dealerEvent);
      console.log(`Applied dealer event:`, dealerEvent);
      appliedEngineEvents.push(ev); // Keep the original event for broadcasting
    }

    // At this point, the move is accepted and applied
    console.log(
      `Intent successfully processed, broadcasting state, scheduling next turn...`
    );

    // Broadcast the updated state with engine events for animations if a callback is provided
    if (broadcastStateCallback) {
      broadcastStateCallback(
        gameId,
        appliedEngineEvents.length > 0 ? appliedEngineEvents : undefined,
        {
          id: Math.random().toString(36).substring(2, 11),
          playerId: intent.playerId,
          action: intent.type === "action" ? intent.action : "move",
          label:
            intent.type === "action"
              ? state.actions?.cells?.find((cell) => cell.id === intent.action)
                  ?.label
              : findMoveLabel(state, intentForEngine),
          ...(intentForEngine.type === "move"
            ? {
                cardId: intentForEngine.cardId,
                fromPileId: intentForEngine.fromPileId,
                toPileId: intentForEngine.toPileId,
              }
            : {}),
        }
      );
    }

    appendGameLogIntent(state, intentForEngine, turnNumberForLog);

    // Schedule next AI turn if needed (for AI players).
    // Forward the broadcast callback so chained AI turns continue to sync clients.
    setTimeout(() => {
      maybeScheduleAiTurn(gameId, broadcastStateCallback);
    }, 0);
    trimFinishedGamesNow();

    return { success: true, engineEvents: appliedEngineEvents };
  } catch (error) {
    console.error("Error handling client intent:", error);
    return { success: false };
  }
}
