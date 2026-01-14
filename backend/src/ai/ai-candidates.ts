// backend/src/ai/ai-candidates.ts
// Default implementations for AI candidate generation and summarization

import type { ClientIntent, GameState } from "../../../shared/schemas.js";
import { listLegalIntentsForPlayer } from "../rule-engine.js";

/**
 * IMPORTANT: Candidate IDs must be opaque, simple, and NOT contain game data.
 *
 * Why: Semantic IDs like "move:P3-hand:271323504748399->discard" allow LLMs to
 * hallucinate plausible-looking candidate IDs by pattern-matching card IDs from
 * the game view. This causes the AI to select non-existent candidates.
 *
 * Solution: Use simple sequential IDs (c0, c1, c2, ...) that cannot be constructed
 * from view data. The summary field provides human-readable context.
 */
export function assignCandidateId(
  _intent: ClientIntent,
  counter: { value: number }
): string {
  const id = `c${counter.value}`;
  counter.value++;
  return id;
}

/**
 * Builds AI candidates for a seat by listing all legal intents.
 * Returns minimal candidate objects with just {intent, summary}.
 *
 * This is used by view.ts when a game doesn't implement the AiSupport interface.
 * Games can optionally implement AiSupport to provide richer context and multi-move candidates.
 */
export function buildAiCandidatesForSeat(
  state: GameState,
  seatId: string
): Array<{ intent: ClientIntent; summary?: string }> {
  const gameId = state.gameId;
  const legalIntents = listLegalIntentsForPlayer(gameId, seatId);

  return legalIntents.map((intent) => ({
    intent,
    summary: summarizeIntent(intent),
  }));
}

function summarizeIntent(intent: ClientIntent): string {
  if (intent.type === "action") {
    return `Press action "${intent.action}"`;
  }
  if (intent.type === "move") {
    return `Move card from "${intent.fromPileId}" to "${intent.toPileId}"`;
  }
  return `Perform intent of type "${(intent as { type: string }).type}"`;
}
