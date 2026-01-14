// backend/src/ai/ai-policy.ts

import type {
  ClientIntent,
  GameView as PlayerGameView,
  GameState,
} from "../../../shared/schemas.js";
import type { AiCandidate, AiView } from "../../../shared/src/ai/types.js";
import {
  chooseAiIntentWithLlm,
  resolveRulesMarkdown,
} from "./ai-llm-policy.js";
import { assignCandidateId } from "./ai-candidates.js";
import { listLegalIntentsForPlayer } from "../rule-engine.js";
import { appendAiLogEntry, sendGameStatus } from "./ai-log.js";
import { getHumanTurnNumber } from "../state.js";
import { getEnvironmentConfig } from "../config.js";
import { buildAiMessages } from "../../../shared/src/ai/prompts.js";
import type { AiTurnInput } from "../../../shared/src/ai/types.js";
import { getViewSalt } from "../state.js";
import { toViewCardId } from "../view-ids.js";
import { GAME_PLUGINS } from "../rules/registry.js";

export type AiIntentCandidate = AiCandidate & {
  intent: ClientIntent;
};

export interface AiPolicyInput {
  rulesId: string;
  playerId: string;
  view: PlayerGameView;
  candidates: AiIntentCandidate[];
  turnNumber: number;
}

function sanitizeAiRulesState(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeAiRulesState(entry));
  }

  const obj = value as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(obj)) {
    if (key.toLowerCase().includes("score")) continue;
    cleaned[key] = sanitizeAiRulesState(entry);
  }
  return cleaned;
}

function stripRecapFromView(view: AiView): AiView {
  const publicData =
    view.public && typeof view.public === "object"
      ? (view.public as Record<string, unknown>)
      : null;
  if (!publicData) return view;

  const rulesState =
    publicData.rulesState && typeof publicData.rulesState === "object"
      ? (publicData.rulesState as Record<string, unknown>)
      : null;
  if (!rulesState || !("recap" in rulesState)) return view;

  const nextRulesState = { ...rulesState };
  delete nextRulesState.recap;

  return {
    ...view,
    public: {
      ...publicData,
      rulesState: nextRulesState,
    },
  };
}

/**
 * Builds a hardened, seat-specific view for the AI.
 * Explicitly picks only fields needed for strategy to prevent leakage.
 * Optimized to minimize token usage by omitting hidden card details.
 */
function buildHardenedAiView(view: PlayerGameView, seatId: string): AiView {
  const safeRulesState = sanitizeAiRulesState(view.rulesState);

  return {
    seat: seatId,
    public: {
      gameId: view.gameId,
      currentPlayer: view.currentPlayer,
      piles: view.piles
        .filter((p) => (p.totalCards ?? 0) > 0) // Omit empty piles entirely
        .map((p) => {
          // Check if any cards in this pile are visible (have rank/suit)
          const hasVisibleCards = p.cards?.some((c) => c.rank !== undefined);

          if (hasVisibleCards) {
            // Include full card details for visible piles
            return {
              id: p.id,
              label: p.label,
              ownerId: p.ownerId,
              totalCards: p.totalCards,
              cards: p.cards
                ?.filter((c) => c.rank !== undefined) // Only include visible cards
                .map((c) => ({
                  rank: c.rank,
                  suit: c.suit,
                })),
            };
          } else {
            // For hidden piles, just show count (no cards array)
            return {
              id: p.id,
              label: p.label,
              ownerId: p.ownerId,
              totalCards: p.totalCards,
            };
          }
        }),
      rulesState: safeRulesState,
    },
    private: {
      // AI only needs to know its legal intents from the hardened view
      legalIntents: view.legalIntents,
    },
  };
}

export async function buildAiRequestPayload(input: AiPolicyInput): Promise<{
  req: AiTurnInput;
  idMap: Map<string, AiIntentCandidate>;
}> {
  // Log the candidates
  appendAiLogEntry({
    gameId: input.view.gameId ?? "unknown",
    turnNumber: input.turnNumber,
    playerId: input.playerId,
    phase: "candidates",
    level: "info",
    message: `Generated ${input.candidates.length} AI intent candidates.`,
    source: "backend",
    details: {
      kind: "candidates",
      candidates: input.candidates.map((c) => ({
        id: c.id,
        summary: c.summary,
      })),
    },
  });

  // Build hardened view for new contract
  const view = buildHardenedAiView(input.view, input.playerId);

  // Get plugin and call buildContext if available
  // Each game should implement its own recap via buildContext
  const plugin = GAME_PLUGINS[input.rulesId];
  const context = plugin?.aiSupport?.buildContext?.(view) ?? {};

  // Default to empty recap if plugin didn't provide one
  // (Games should implement buildContext to provide their own recap)
  if (!context.recap) {
    context.recap = [];
  }

  // Try to resolve rules markdown for this game
  const rulesMarkdown = (await resolveRulesMarkdown(input.rulesId)) ?? "";

  const req: AiTurnInput = {
    view: stripRecapFromView(view),
    context,
    rulesMarkdown,
    candidates: input.candidates.map((c) => ({
      id: c.id,
      summary: c.summary,
    })),
  };

  // Build ID map for looking up intents after LLM responds
  const idMap = new Map<string, AiIntentCandidate>();
  for (const candidate of input.candidates) {
    idMap.set(candidate.id, candidate);
  }

  return { req, idMap };
}

export class AiPolicyError extends Error {
  details?: string;

  constructor(message: string, details?: string) {
    super(message);
    this.name = "AiPolicyError";
    this.details = details;
  }
}

const MAX_TOTAL_CANDIDATES = 120; // hard cap to protect the LLM

function resolveSeatRuntime(seat: {
  aiRuntime?: "none" | "backend" | "frontend";
  isAi?: boolean;
}): "none" | "backend" | "frontend" {
  return seat.aiRuntime ?? (seat.isAi ? "backend" : "none");
}

function areAllSeatsAutomated(game: GameState): boolean {
  return (
    game.players.length > 0 &&
    game.players.every((seat) => resolveSeatRuntime(seat) !== "none")
  );
}

function isPassAction(intent: ClientIntent): boolean {
  return (
    intent.type === "action" && intent.action.trim().toLowerCase() === "pass"
  );
}

function pickDefaultCandidate(
  candidates: AiIntentCandidate[]
): AiIntentCandidate | undefined {
  if (candidates.length === 0) return undefined;
  const nonPass = candidates.find(
    (candidate) => !isPassAction(candidate.intent)
  );
  return nonPass ?? candidates[0];
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Sorts intents deterministically to ensure stable ID assignment.
 */
function sortIntents(intents: ClientIntent[]): ClientIntent[] {
  return [...intents].sort((a, b) => {
    // 1. Sort by type
    if (a.type !== b.type) return a.type.localeCompare(b.type);

    // 2. Sort by action/pile/card specific fields
    if (a.type === "action" && b.type === "action") {
      return a.action.localeCompare(b.action);
    }

    if (a.type === "move" && b.type === "move") {
      if (a.fromPileId !== b.fromPileId)
        return a.fromPileId.localeCompare(b.fromPileId);
      if (a.toPileId !== b.toPileId)
        return a.toPileId.localeCompare(b.toPileId);

      // XOR cardId vs cardIds
      const aId = a.cardId ?? 0;
      const targetCardId = b.cardId ?? 0;
      if (aId !== targetCardId) return aId - targetCardId;

      const aIds = (a.cardIds ?? []).join(",");
      const bIds = (b.cardIds ?? []).join(",");
      return aIds.localeCompare(bIds);
    }

    return 0;
  });
}

function enumerateCandidatesFromView(
  _game: GameState,
  view: PlayerGameView,
  playerId: string,
  idCounter: { value: number }
): AiIntentCandidate[] {
  const candidates: AiIntentCandidate[] = [];
  const gameId = view.gameId;

  // --- 1. Action candidates (buttons) ---
  const actionCells = view.actions?.cells ?? [];

  for (const cell of actionCells) {
    if (!cell.enabled) continue;

    const intent: ClientIntent = {
      type: "action",
      gameId,
      playerId,
      action: cell.id,
    };

    warnIfNonAsciiIdentifiers(intent);
    const summary = `Press action "${cell.id}"`;
    const id = assignCandidateId(intent, idCounter);

    candidates.push({
      id,
      intent,
      summary,
    });

    // Check if we've reached the limit
    if (candidates.length >= MAX_TOTAL_CANDIDATES) {
      return candidates;
    }
  }

  // --- 2. Card move candidates (drag-like moves) ---
  // Strategy:
  // - FROM piles: all piles owned by this player (ownerId === playerId) with at least one card.
  // - TO piles: all *other* piles (id !== fromPile.id).
  // This mirrors the UI: "you can drag any of your visible cards to any pile".
  // Code rules remain authoritative and will reject illegal combinations.
  //
  // This is intentionally generic:
  // - Bridge: moving from hand to trick pile.
  // - Bridge play: moving from "<player>-hand" to "trick" is in the set; rules enforce phase/constraints.
  // - Scopa/Kasino: all hand → table combinations are present.

  const fromPiles = view.piles.filter(
    (p) => p.ownerId === playerId && p.cards && p.cards.length > 0
  );

  const toPiles = view.piles; // we filter same-id below

  for (const from of fromPiles) {
    for (const card of from.cards) {
      for (const to of toPiles) {
        if (to.id === from.id) continue; // ignore no-op moves

        const intent: ClientIntent = {
          type: "move",
          gameId,
          playerId,
          fromPileId: from.id,
          toPileId: to.id,
          cardId: card.id,
        };

        warnIfNonAsciiIdentifiers(intent);
        const cardLabel = formatPrimaryLabel(intent, view) || "card";
        const summary = `Move ${cardLabel} from "${from.label}" to "${to.label}"`;
        const moveId = assignCandidateId(intent, idCounter);

        candidates.push({
          id: moveId,
          intent,
          summary,
        });

        // Basic safety cap: stop if we exceed max
        if (candidates.length >= MAX_TOTAL_CANDIDATES) {
          return candidates;
        }
      }
    }
  }

  return candidates;
}

function summarizeIntent(view: PlayerGameView, intent: ClientIntent): string {
  if (intent.type === "action") {
    return `Press action "${intent.action}"`;
  }
  if (intent.type === "move") {
    const pilesById = new Map(view.piles.map((p) => [p.id, p]));
    const from = pilesById.get(intent.fromPileId);
    const to = pilesById.get(intent.toPileId);
    const fromLabel = from?.label ?? intent.fromPileId;
    const toLabel = to?.label ?? intent.toPileId;
    const cardLabel = formatPrimaryLabel(intent, view) || "card";
    if (intent.fromPileId === "discard") {
      return `Take discard pile (move ${cardLabel} to "${toLabel}")`;
    }
    let pileNote = "";
    if (intent.cardIds && intent.cardIds.length > 1) {
      if (!to) {
        pileNote = " (pile)";
      } else {
        pileNote =
          (to.totalCards ?? 0) > 0 ? " (add to pile)" : " (start pile)";
      }
    }
    return `Move ${cardLabel} from "${fromLabel}" to "${toLabel}"${pileNote}`;
  }
  // Future-proof: if ClientIntent gets new variants, fall back to type name
  return `Perform intent of type "${(intent as { type: string }).type}"`;
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

function formatPrimaryLabel(
  intent: ClientIntent,
  view: PlayerGameView
): string {
  if (intent.type === "action") return intent.action;
  if (intent.type !== "move") return "";

  const pilesById = new Map(view.piles.map((p) => [p.id, p]));
  const from = pilesById.get(intent.fromPileId);

  const formatCardLabel = (card: {
    label?: string;
    rank?: string;
    suit?: string;
  }): string => {
    if (card.label) return card.label;
    const rank = card.rank ?? "?";
    const suit = card.suit ?? "";
    return `${rank}${suit}`.trim() || "?";
  };

  // Handle multi-card moves (cardIds array)
  if (intent.cardIds && intent.cardIds.length > 0) {
    const cards = intent.cardIds
      .map((id) => from?.cards?.find((c) => c.id === id))
      .filter((c) => c !== undefined);

    if (cards.length === 0) return "?";
    if (cards.length === 1) {
      return formatCardLabel(cards[0]);
    }

    const labels = cards.map((card) => formatCardLabel(card));
    return `${cards.length} cards (${labels.join(", ")})`;
  }

  // Handle single-card moves (cardId)
  const card = from?.cards?.find((c) => c.id === intent.cardId);
  if (!card) return "?";
  return formatCardLabel(card);
}

/**
 * Prepares the filtered candidate list and other metadata needed for an AI decision.
 */
export function getAiDecisionContext(
  gameId: string,
  game: GameState,
  view: PlayerGameView,
  playerId: string
): {
  candidates: AiIntentCandidate[];
  allowStartGame: boolean;
} {
  let rawCandidates: AiIntentCandidate[] = [];
  const idCounter = { value: 0 };

  // 1. Try rules-provided legal intents (preferred, game-agnostic)
  const viewSalt = getViewSalt(gameId);
  const viewerKey = playerId;
  const legalIntents = sortIntents(
    listLegalIntentsForPlayer(gameId, playerId)
  ).map((intent) =>
    intent.type === "move"
      ? {
          ...intent,
          cardId:
            intent.cardId !== undefined
              ? toViewCardId(intent.cardId, viewSalt, viewerKey)
              : undefined,
          cardIds: intent.cardIds?.map((id) =>
            toViewCardId(id, viewSalt, viewerKey)
          ),
        }
      : intent
  );

  if (legalIntents.length > 0) {
    rawCandidates = legalIntents.map((intent) => {
      warnIfNonAsciiIdentifiers(intent);
      const id = assignCandidateId(intent, idCounter);
      return {
        id,
        intent,
        summary: summarizeIntent(view, intent),
      };
    });
  } else {
    // 2. Fallback: generic enumeration from GameView
    rawCandidates = enumerateCandidatesFromView(
      game,
      view,
      playerId,
      idCounter
    );
  }

  const allowStartGame = areAllSeatsAutomated(game);

  // Only allow AI to consider "start-game" in fully automated tables.
  const filteredCandidates = rawCandidates.filter((c) => {
    const intent = c.intent;
    return !(
      intent.type === "action" &&
      intent.action === "start-game" &&
      !allowStartGame
    );
  });

  // Deduplicate summaries by adding minimal suffixes (#1, #2) for identical cards
  const candidates = deduplicateCandidateSummaries(filteredCandidates);

  return { candidates, allowStartGame };
}

/**
 * When multiple candidates have identical summaries (e.g., two Q♣ from a double deck),
 * add minimal suffixes (#1, #2) to distinguish them without drawing too much attention.
 */
function deduplicateCandidateSummaries(
  candidates: AiIntentCandidate[]
): AiIntentCandidate[] {
  // Count occurrences of each summary
  const summaryCounts = new Map<string, number>();
  for (const c of candidates) {
    const key = c.summary ?? "";
    const count = summaryCounts.get(key) ?? 0;
    summaryCounts.set(key, count + 1);
  }

  // Only process summaries that appear more than once
  const summaryIndexes = new Map<string, number>();

  return candidates.map((c) => {
    const key = c.summary ?? "";
    const count = summaryCounts.get(key) ?? 1;
    if (count <= 1) return c; // No duplicates, keep as-is

    // Assign incrementing index for this summary
    const idx = (summaryIndexes.get(key) ?? 0) + 1;
    summaryIndexes.set(key, idx);

    return {
      ...c,
      summary: `${c.summary ?? ""} #${idx}`,
    };
  });
}

/**
 * High-level helper to prepare a full AI prompt payload (messages + context).
 */
export async function prepareAiPromptPayload(
  gameId: string,
  game: GameState,
  view: PlayerGameView,
  playerId: string
): Promise<{
  messages: unknown[];
  candidates: Array<{ id: string; summary: string }>;
  context: { candidates: AiIntentCandidate[] };
}> {
  const { candidates } = getAiDecisionContext(gameId, game, view, playerId);

  const { buildAiRequestPayload } = await import("./ai-policy.js");
  const turnNumberForLog = getHumanTurnNumber(gameId);
  const { req, idMap } = await buildAiRequestPayload({
    rulesId: game.rulesId,
    playerId,
    view,
    candidates,
    turnNumber: turnNumberForLog,
  });

  const messages = buildAiMessages(req);
  const contextCandidates: AiIntentCandidate[] = req.candidates.map(
    (candidate) => {
      const original = idMap.get(candidate.id);
      if (!original) {
        throw new Error(
          `[AI] Critical mapping failure: Missing original candidate for id "${candidate.id}"`
        );
      }
      return {
        id: candidate.id,
        summary: candidate.summary ?? "",
        intent: original.intent,
      };
    }
  );

  return {
    messages,
    candidates: req.candidates.map((c) => ({
      id: c.id,
      summary: c.summary ?? "",
    })),
    context: { candidates: contextCandidates },
  };
}

export async function chooseAiIntent(
  gameId: string,
  game: GameState,
  view: PlayerGameView,
  playerId: string,
  turnNumber: number,
  preGatheredCandidates?: AiIntentCandidate[]
): Promise<ClientIntent | null> {
  const config = getEnvironmentConfig();
  const policyMode = config.llmPolicyMode;

  const candidates =
    preGatheredCandidates ??
    getAiDecisionContext(gameId, game, view, playerId).candidates;

  // Check for deterministic test mode
  if (policyMode === "firstCandidate") {
    const chosen = pickDefaultCandidate(candidates);
    console.log("AI using deterministic default candidate mode", {
      playerId,
      candidateId: chosen?.id,
    });
    appendAiLogEntry({
      gameId,
      turnNumber,
      playerId,
      phase: "execution",
      level: "info",
      message: `Using deterministic default candidate mode: ${chosen?.id ?? "none"}`,
    });
    return chosen?.intent ?? null;
  }

  if (candidates.length === 0) {
    console.log(
      `AI ${playerId} has no non-start-game candidates (game may not have started yet); skipping AI move.`
    );
    appendAiLogEntry({
      gameId,
      turnNumber,
      playerId,
      phase: "execution",
      level: "error",
      message: "AI could not find any legal intent; treating as fatal.",
    });
    return null;
  }

  if (candidates.length === 1) {
    const onlyCandidate = candidates[0];
    const rulesState = view.rulesState as
      | { cardsPlayedToMeldsThisTurn?: unknown }
      | null
      | undefined;
    const priorMelds = Array.isArray(rulesState?.cardsPlayedToMeldsThisTurn)
      ? rulesState?.cardsPlayedToMeldsThisTurn.length
      : 0;
    const intent = onlyCandidate.intent;
    const isFollowUpMove =
      priorMelds > 0 &&
      intent.type === "move" &&
      intent.fromPileId.endsWith("-hand") &&
      intent.toPileId !== "discard";
    if (isFollowUpMove) {
      sendGameStatus(
        gameId,
        `Auto-applied follow-up move: ${onlyCandidate.summary ?? "move"}.`,
        "info",
        "engine"
      );
    }

    console.log("AI has single candidate, using it directly", {
      playerId,
      candidateId: candidates[0].id,
    });
    appendAiLogEntry({
      gameId,
      turnNumber,
      playerId,
      phase: "llm",
      level: "info",
      message: `AI has a single candidate, using it directly: ${candidates[0].id}`,
    });
    return candidates[0].intent;
  }

  // LLM policy selection.
  let chosenCandidate = null;
  let llmFailureDetails: string | undefined;
  try {
    chosenCandidate = await chooseAiIntentWithLlm({
      rulesId: game.rulesId,
      playerId,
      view,
      candidates, // NOTE: pass the filtered list here
      turnNumber,
    });
    if (!chosenCandidate) {
      console.log("AI LLM did not return usable candidate id", { playerId });
      llmFailureDetails =
        "LLM response did not parse or did not match any candidate id.";
    }
  } catch (err) {
    llmFailureDetails = describeError(err);
    console.error("Error while calling AI policy LLM:", err);
  }

  if (!chosenCandidate) {
    const details =
      llmFailureDetails ?? "LLM response did not return a usable candidate id.";
    throw new AiPolicyError("LLM policy failed to select a move.", details);
  }

  console.log("AI selected intent from candidates", {
    playerId,
    candidateCount: candidates.length,
    intent: chosenCandidate.intent,
  });
  return chosenCandidate.intent;
}
