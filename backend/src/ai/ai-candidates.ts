// backend/src/ai/ai-candidates.ts
import type { ClientIntent, GameState } from "../../../shared/schemas.js";
import type { AiCandidate } from "../../../shared/src/ai/types.js";
import { listLegalIntentsForPlayer } from "../rule-engine.js";

export function candidateIdForIntent(intent: ClientIntent): string {
  switch (intent.type) {
    case "action":
      return `action:${intent.action}`;
    case "move":
      return `move:${intent.fromPileId}:cardId_${intent.cardId}->${intent.toPileId}`;
    default:
      return `intent:${(intent as { type: string }).type}`;
  }
}

export function assignCandidateId(
  intent: ClientIntent,
  usedIds: Map<string, number>
): string {
  const baseId = candidateIdForIntent(intent);
  const count = usedIds.get(baseId) ?? 0;
  const next = count + 1;
  usedIds.set(baseId, next);
  return count === 0 ? baseId : `${baseId}#${next}`;
}

export function buildAiCandidatesForSeat(
  state: GameState,
  seatId: string
): AiCandidate[] {
  const intents = listLegalIntentsForPlayer(state.gameId, seatId);
  const usedIds = new Map<string, number>();

  if (intents.length > 0) {
    // Sort intents: put discards and turn-ending actions first
    const sortedIntents = [...intents].sort((a, b) => {
      const aIsEnd =
        a.type === "action" || (a.type === "move" && a.toPileId === "discard");
      const bIsEnd =
        b.type === "action" || (b.type === "move" && b.toPileId === "discard");
      if (aIsEnd && !bIsEnd) return -1;
      if (!aIsEnd && bIsEnd) return 1;
      return 0;
    });

    return sortedIntents.map((intent) => {
      warnIfNonAsciiIdentifiers(intent);
      return {
        id: assignCandidateId(intent, usedIds),
        summary: summarizeIntent(intent, state),
        intent,
      };
    });
  }

  // Fallback: enumerate generic candidates from current state so frontend AI is never empty.
  const candidates: AiCandidate[] = [];

  // Actions grid
  const actionCells = state.actions?.cells ?? [];
  for (const cell of actionCells) {
    if (!cell.enabled) continue;
    const intent: ClientIntent = {
      type: "action",
      gameId: state.gameId,
      playerId: seatId,
      action: cell.id,
    };
    warnIfNonAsciiIdentifiers(intent);
    candidates.push({
      id: assignCandidateId(intent, usedIds),
      summary: summarizeIntent(intent, state),
      intent,
    });
  }

  // Card moves: any card in this player's piles to any other pile
  const piles = Object.values(state.piles);
  const fromPiles = piles.filter(
    (p) =>
      p.ownerId === seatId && Array.isArray(p.cardIds) && p.cardIds.length > 0
  );

  for (const from of fromPiles) {
    for (const cardId of from.cardIds) {
      for (const to of piles) {
        if (to.id === from.id) continue;
        const intent: ClientIntent = {
          type: "move",
          gameId: state.gameId,
          playerId: seatId,
          fromPileId: from.id,
          toPileId: to.id,
          cardId,
        };
        warnIfNonAsciiIdentifiers(intent);
        candidates.push({
          id: assignCandidateId(intent, usedIds),
          summary: summarizeIntent(intent, state),
          intent,
        });
      }
    }
  }

  return candidates;
}

function summarizeIntent(intent: ClientIntent, state: GameState): string {
  switch (intent.type) {
    case "action":
      return `Press action "${intent.action}"`;
    case "move": {
      const cardLabel = formatCardLabel(state, intent.cardId);
      const to = intent.toPileId;
      const suffix =
        to === "discard"
          ? " (ends turn)"
          : to.includes("meld")
            ? " (meld)"
            : "";
      return `Move ${cardLabel} from "${intent.fromPileId}" to "${intent.toPileId}"${suffix}`;
    }
    default:
      return `Action: ${(intent as { type: string }).type}`;
  }
}

function warnIfNonAsciiIdentifiers(intent: ClientIntent): void {
  const warn = (value: string | undefined, label: string) => {
    if (!value) return;
    if (/[^\x20-\x7E]/.test(value)) {
      console.warn(
        `[AI-POLICY] WARNING: Unsafe ${label} detected: "${value}". ` +
          `Action IDs and Pile IDs should be ASCII-only to ensure reliable LLM selection.`
      );
    }
  };

  if (intent.type === "action") {
    warn(intent.action, "action id");
  } else if (intent.type === "move") {
    warn(intent.fromPileId, "fromPileId");
    warn(intent.toPileId, "toPileId");
  }
}

function formatCardLabel(state: GameState, cardId: number): string {
  const card = state.cards[cardId];
  if (!card) return String(cardId);
  const rank = card.rank ?? "?";
  const suit = card.suit ?? "";
  return `${rank}${suit}`;
}
