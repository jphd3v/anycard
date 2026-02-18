import type {
  ClientIntent,
  EventExecutorRole,
  MoveIntent,
} from "../../shared/schemas.js";
import type { EngineEvent } from "../../shared/validation.js";

export type EventAttribution = {
  initiatedByPlayerId: string;
  initiatedByIntentType: "move" | "action";
  executorRole: EventExecutorRole;
};

export type EventAttributionContext = {
  directMoveAssigned: boolean;
};

function moveIntentCardIds(intent: MoveIntent): number[] {
  if (Array.isArray(intent.cardIds)) return intent.cardIds;
  if (typeof intent.cardId === "number") return [intent.cardId];
  return [];
}

function cardsMatch(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  const leftCounts = new Map<number, number>();
  for (const cardId of left) {
    leftCounts.set(cardId, (leftCounts.get(cardId) ?? 0) + 1);
  }
  for (const cardId of right) {
    const count = leftCounts.get(cardId);
    if (!count) return false;
    if (count === 1) {
      leftCounts.delete(cardId);
    } else {
      leftCounts.set(cardId, count - 1);
    }
  }
  return leftCounts.size === 0;
}

function isDirectMoveEvent(intent: MoveIntent, event: EngineEvent): boolean {
  if (event.type !== "move-cards") return false;
  if (event.fromPileId !== intent.fromPileId) return false;
  if (event.toPileId !== intent.toPileId) return false;
  if (!cardsMatch(moveIntentCardIds(intent), event.cardIds)) return false;

  // Preserve stricter matching for reorder moves.
  if (typeof intent.targetIndex === "number") {
    return event.targetIndex === intent.targetIndex;
  }
  return true;
}

export function resolveEventAttribution(
  intent: ClientIntent,
  event: EngineEvent,
  context: EventAttributionContext
): EventAttribution {
  let executorRole: EventExecutorRole = "system";

  if (
    intent.type === "move" &&
    !context.directMoveAssigned &&
    isDirectMoveEvent(intent, event)
  ) {
    executorRole = "player";
    context.directMoveAssigned = true;
  }

  return {
    initiatedByPlayerId: intent.playerId,
    initiatedByIntentType: intent.type,
    executorRole,
  };
}
