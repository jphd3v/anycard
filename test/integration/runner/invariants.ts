import assert from "node:assert/strict";

import type {
  ClientIntent,
  GameEvent,
  GameState,
} from "../../../shared/schemas.js";
import { GameEventPayloadSchema } from "../../../shared/schemas.js";

export type LegalIntentLister = (
  state: GameState,
  events: GameEvent[],
  playerId: string
) => ClientIntent[];

function isGloballyAllowedAction(intent: ClientIntent): boolean {
  return (
    intent.type === "action" &&
    (intent.action === "start-game" || intent.action === "call-last-card")
  );
}

export function assertEngineEventPayloads(
  events: GameEvent[],
  context: string
): void {
  for (let index = 0; index < events.length; index += 1) {
    const parsed = GameEventPayloadSchema.safeParse(events[index]);
    assert.ok(
      parsed.success,
      `[integration] ${context}: invalid engine event payload at index ${index}: ${parsed.error?.message ?? "unknown schema error"}`
    );
  }
}

export function assertCardConservation(
  state: GameState,
  context: string
): void {
  const expectedIds = Object.keys(state.cards).map((id) => Number(id));
  const expectedSet = new Set(expectedIds);
  const seenCounts = new Map<number, number>();

  for (const [pileId, pile] of Object.entries(state.piles)) {
    for (const cardId of pile.cardIds) {
      assert.ok(
        expectedSet.has(cardId),
        `[integration] ${context}: pile '${pileId}' contains unknown cardId ${cardId}`
      );
      seenCounts.set(cardId, (seenCounts.get(cardId) ?? 0) + 1);
    }
  }

  for (const cardId of expectedIds) {
    const count = seenCounts.get(cardId) ?? 0;
    assert.equal(
      count,
      1,
      `[integration] ${context}: card ${cardId} expected exactly once across piles, got ${count}`
    );
  }
}

export function assertTurnOwnership(
  state: GameState,
  events: GameEvent[],
  listLegalIntentsForPlayer: LegalIntentLister,
  context: string
): void {
  const currentPlayer = state.currentPlayer;
  if (!currentPlayer) return;

  for (const player of state.players) {
    if (player.id === currentPlayer) continue;
    const intents = listLegalIntentsForPlayer(state, events, player.id);
    const disallowed = intents.filter(
      (intent) => !isGloballyAllowedAction(intent)
    );
    assert.equal(
      disallowed.length,
      0,
      `[integration] ${context}: non-turn player '${player.id}' has playable intents while currentPlayer='${currentPlayer}'`
    );
  }
}

export function assertTerminalStateContract(
  state: GameState,
  events: GameEvent[],
  listLegalIntentsForPlayer: LegalIntentLister,
  context: string
): void {
  if (!state.winner) return;

  assert.equal(
    state.currentPlayer,
    null,
    `[integration] ${context}: winner is set ('${state.winner}') but currentPlayer is not null`
  );

  for (const player of state.players) {
    const intents = listLegalIntentsForPlayer(state, events, player.id);
    const disallowed = intents.filter(
      (intent) => !isGloballyAllowedAction(intent)
    );
    assert.equal(
      disallowed.length,
      0,
      `[integration] ${context}: winner is set but player '${player.id}' still has playable intents`
    );
  }
}

export function assertGlobalStateInvariants(
  state: GameState,
  events: GameEvent[],
  listLegalIntentsForPlayer: LegalIntentLister,
  context: string
): void {
  assertCardConservation(state, context);
  assertTurnOwnership(state, events, listLegalIntentsForPlayer, context);
  assertTerminalStateContract(
    state,
    events,
    listLegalIntentsForPlayer,
    context
  );
}
