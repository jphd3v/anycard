import type { GameView } from "../../schemas.js";
import type { AiCandidate } from "./types.js";

export interface CompactAiViewResult {
  view: Record<string, unknown>;
  cardIdMap: Map<number, number>;
}

/**
 * IMPORTANT: AI must not see more than the current player.
 * makeCompactAiView strips UI-only and debug fields from GameView.
 */
export function makeCompactAiView(view: GameView): CompactAiViewResult {
  let nextCardId = 1;
  const cardIdMap = new Map<number, number>();

  const shouldMapSingleCardId = (
    key: string,
    value: unknown
  ): value is number => {
    if (typeof value !== "number") return false;
    const lower = key.toLowerCase();
    return (
      lower.includes("cardid") ||
      lower.startsWith("card") ||
      lower.startsWith("cards")
    );
  };

  const shouldMapCardIdArray = (
    key: string,
    value: unknown
  ): value is number[] => {
    if (!Array.isArray(value)) return false;
    const lower = key.toLowerCase();
    return (
      lower.includes("cardids") ||
      lower.startsWith("card") ||
      lower.startsWith("cards")
    );
  };

  const mapRulesStateCardIds = (value: unknown, key?: string): unknown => {
    if (key && shouldMapSingleCardId(key, value)) {
      if (cardIdMap.has(value)) {
        return cardIdMap.get(value);
      }
      return null;
    }
    if (key && shouldMapCardIdArray(key, value)) {
      return value
        .map((entry) =>
          typeof entry === "number" && cardIdMap.has(entry)
            ? cardIdMap.get(entry)
            : null
        )
        .filter((entry) => entry != null);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => mapRulesStateCardIds(entry));
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const next: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(obj)) {
        next[childKey] = mapRulesStateCardIds(childValue, childKey);
      }
      return next;
    }
    return value;
  };

  const compactView = {
    ...view,
    gameId: undefined,
    rulesId: undefined,
    gameName: undefined,
    stateVersion: undefined,
    currentPlayer: undefined,
    currentSeatId: undefined,
    lastEngineEvents: undefined,
    lastViewEvents: undefined,
    lastFatalErrors: undefined,
    metadata: undefined,
    legalIntents: undefined,
    aiCandidatesForCurrentTurn: undefined,
    sponsoredAiViews: undefined,
    actions: {
      rows: 0,
      cols: 0,
      cells: [],
    },
    seats: (view.seats ?? []).map((seat) => ({
      seatId: seat.seatId,
    })),
    piles: view.piles.map(({ cards, ...rest }) => {
      const visibleCards = (cards ?? []).filter((card) => !card.faceDown);
      const totalCards =
        typeof rest.totalCards === "number"
          ? rest.totalCards
          : visibleCards.length;
      const hiddenCount = Math.max(totalCards - visibleCards.length, 0);
      return {
        ...rest,
        label: undefined,
        layout: undefined,
        ...(hiddenCount > 0 ? { hiddenCount } : {}),
        cards: visibleCards.map(({ id, rank, suit }) => {
          const compactId = nextCardId++;
          cardIdMap.set(id, compactId);
          return {
            id: compactId,
            faceDown: false,
            rank,
            suit,
          };
        }),
      };
    }),
    rulesState: (() => {
      const mapped = mapRulesStateCardIds(view.rulesState);
      if (mapped && typeof mapped === "object") {
        const { agentGuide: _, ...rest } = mapped as Record<string, unknown>;
        return rest;
      }
      return mapped;
    })(),
  };
  return { view: compactView, cardIdMap };
}

function remapCandidateId(id: string, cardIdMap: Map<number, number>): string {
  if (!id.startsWith("move:")) return id;
  const match = id.match(/^move:(.+):cardId_(\d+)->(.+?)(#\d+)?$/);
  if (!match) return id;
  const [, fromPileId, rawCardId, toPileId, suffix] = match;
  const cardId = Number(rawCardId);
  if (!Number.isFinite(cardId)) return id;
  const mapped = cardIdMap.get(cardId);
  if (!mapped) return id;
  return `move:${fromPileId}:cardId_${mapped}->${toPileId}${suffix ?? ""}`;
}

function remapCandidateIntent(
  candidate: AiCandidate,
  cardIdMap: Map<number, number>
): AiCandidate {
  const intent = candidate.intent;
  if (
    intent &&
    typeof intent === "object" &&
    "type" in intent &&
    (intent as { type?: string }).type === "move" &&
    "cardId" in intent &&
    typeof (intent as { cardId?: unknown }).cardId === "number"
  ) {
    const cardId = (intent as { cardId: number }).cardId;
    const mapped = cardIdMap.get(cardId);
    if (mapped) {
      return {
        ...candidate,
        intent: { ...(intent as Record<string, unknown>), cardId: mapped },
      };
    }
  }
  return candidate;
}

export function remapCandidatesForCompactView(
  candidates: AiCandidate[],
  cardIdMap: Map<number, number>
): { candidates: AiCandidate[]; idMap: Map<string, AiCandidate> } {
  const remapped: AiCandidate[] = [];
  const idMap = new Map<string, AiCandidate>();

  for (const candidate of candidates) {
    const remappedIntent = remapCandidateIntent(candidate, cardIdMap);
    const remappedId = remapCandidateId(remappedIntent.id, cardIdMap);
    const remappedCandidate = {
      ...remappedIntent,
      id: remappedId,
    };
    remapped.push(remappedCandidate);
    idMap.set(remappedCandidate.id, candidate);
  }

  return { candidates: remapped, idMap };
}
