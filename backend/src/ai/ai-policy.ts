// backend/src/ai/ai-policy.ts

import type {
  ClientIntent,
  GameView as PlayerGameView,
  GameState,
} from "../../../shared/schemas.js"; // adjust to your actual types
import type { AiCandidate as SharedAiCandidate } from "../../../shared/src/ai/types.js";
import {
  chooseAiIntentWithLlm,
  resolveRulesMarkdown,
} from "./ai-llm-policy.js";
import { assignCandidateId } from "./ai-candidates.js";
import { listLegalIntentsForPlayer } from "../rule-engine.js";
import { appendAiLogEntry } from "./ai-log.js";
import { getHumanTurnNumber, getViewSalt } from "../state.js";
import { toViewCardId } from "../view-ids.js";
import { getEnvironmentConfig } from "../config.js";
import {
  makeCompactAiView,
  remapCandidatesForCompactView,
} from "../../../shared/src/ai/compact-view.js";
import type { AiRequest } from "../../../shared/src/ai/types.js";
import { buildAiMessages } from "../../../shared/src/ai/prompts.js";

export type AiIntentCandidate = SharedAiCandidate & {
  intent: ClientIntent;
};

export interface AiPolicyInput {
  rulesId: string;
  playerId: string;
  view: PlayerGameView;
  candidates: AiIntentCandidate[];
  turnNumber: number;
}

export async function buildAiRequestPayload(input: AiPolicyInput): Promise<{
  req: AiRequest;
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

  const agentGuide = (
    input.view.rulesState as Record<string, unknown> | undefined
  )?.agentGuide;
  const { view: compactView, cardIdMap } = makeCompactAiView(input.view);
  const { candidates: promptCandidates, idMap } = remapCandidatesForCompactView(
    input.candidates,
    cardIdMap
  );

  const req: AiRequest = {
    rulesId: input.rulesId,
    seatId: input.playerId,
    view: compactView,
    candidates: promptCandidates,
    rulesMarkdown: await resolveRulesMarkdown(input.rulesId),
    agentGuide,
  };

  // The idMap from remapCandidatesForCompactView maps compact IDs to original candidates.
  // We need to ensure the caller gets the original AiIntentCandidate objects.
  return { req, idMap: idMap as Map<string, AiIntentCandidate> };
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

function formatCardLabel(card: {
  label?: string;
  rank?: string;
  suit?: string;
  faceDown?: boolean;
}): string {
  if (card.faceDown) return "face-down card";
  const rank = card.rank ?? "?";
  const suit = card.suit ?? "";
  return `${rank}${suit}`;
}

function enumerateCandidatesFromView(
  game: GameState,
  view: PlayerGameView,
  playerId: string,
  usedIds: Map<string, number>
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
    const id = assignCandidateId(intent, usedIds);

    candidates.push({ id, intent, summary });

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
        const cardLabel = formatCardLabel(card);
        const summary = `Move ${cardLabel} from "${from.label}" to "${to.label}"`;
        const moveId = assignCandidateId(intent, usedIds);

        candidates.push({ id: moveId, intent, summary });

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
    const card = from?.cards?.find((c) => c.id === intent.cardId);
    const cardLabel = card ? formatCardLabel(card) : "card";
    return `Move ${cardLabel} from "${fromLabel}" to "${toLabel}"`;
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
  const usedIds = new Map<string, number>();

  // 1. Try rules-provided legal intents (preferred, game-agnostic)
  const viewSalt = getViewSalt(gameId);
  const viewerKey = playerId;
  const legalIntents = listLegalIntentsForPlayer(gameId, playerId).map(
    (intent) =>
      intent.type === "move"
        ? {
            ...intent,
            cardId: toViewCardId(intent.cardId, viewSalt, viewerKey),
          }
        : intent
  );

  if (legalIntents.length > 0) {
    rawCandidates = legalIntents.map((intent) => {
      warnIfNonAsciiIdentifiers(intent);
      return {
        id: assignCandidateId(intent, usedIds),
        intent,
        summary: summarizeIntent(view, intent),
      };
    });
  } else {
    // 2. Fallback: generic enumeration from GameView
    rawCandidates = enumerateCandidatesFromView(game, view, playerId, usedIds);
  }

  const allowStartGame = areAllSeatsAutomated(game);

  // Only allow AI to consider "start-game" in fully automated tables.
  const candidates = rawCandidates.filter((c) => {
    const intent = c.intent;
    return !(
      intent.type === "action" &&
      intent.action === "start-game" &&
      !allowStartGame
    );
  });

  return { candidates, allowStartGame };
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
        console.warn(
          `[AI] Missing original candidate for compact id "${candidate.id}"`
        );
      }
      return {
        id: candidate.id,
        summary: candidate.summary,
        intent: (original?.intent ?? candidate.intent) as ClientIntent,
      };
    }
  );

  return {
    messages,
    candidates: req.candidates.map((c) => ({
      id: c.id,
      summary: c.summary,
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
