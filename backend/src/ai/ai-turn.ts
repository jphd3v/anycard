// backend/src/ai/ai-turn.ts

import type { EngineEvent } from "../../../shared/validation.js";
import type {
  ClientIntent,
  LastAction,
  Player,
} from "../../../shared/schemas.js";
import { getHumanTurnNumber, projectState } from "../state.js";
import { buildViewForPlayer } from "../view.js";
import {
  AiPolicyError,
  chooseAiIntent,
  getAiDecisionContext,
} from "./ai-policy.js";
import { handleClientIntent } from "../intent-handler.js";
import { appendAiLogEntry, sendGameStatus } from "./ai-log.js";
import { emitFatalErrorEvent } from "../engine-events.js";
import { getEnvironmentConfig, isServerAiEnabled } from "../config.js";
import { AiError } from "../../../shared/src/ai/types.js";

const config = getEnvironmentConfig();
const LLM_MIN_THINK_TIME_MS = config.llmMinThinkTimeMs; // default 300ms; set 0 or negative to disable
const LLM_TURN_TIMEOUT_MS = config.llmTurnTimeoutMs;
// 0 or negative = disabled (no timeout)

export async function runAiTurn(
  gameId: string,
  playerId: string,
  broadcastStateCallback?: (
    gameId: string,
    lastEngineEvents?: EngineEvent[],
    lastAction?: LastAction
  ) => void
): Promise<void> {
  if (!isServerAiEnabled()) {
    appendAiLogEntry({
      gameId,
      turnNumber: getHumanTurnNumber(gameId),
      playerId,
      phase: "execution",
      level: "warn",
      message: "Server AI disabled; aborting AI turn.",
    });
    return;
  }

  const turnNumber = getHumanTurnNumber(gameId);
  const startedAt = Date.now();
  // Re-load game; state may have changed since scheduling.
  const game = projectState(gameId);
  if (!game) {
    appendAiLogEntry({
      gameId,
      turnNumber,
      playerId,
      phase: "execution",
      level: "error",
      message: "Game not found when running AI turn",
    });
    return;
  }

  const currentPlayerId = game.currentPlayer; // adapt to your actual field
  const rulesState = game.rulesState ?? {};
  const hasDealt = (rulesState as { hasDealt?: boolean }).hasDealt;
  const canStartGameWithoutTurn =
    typeof hasDealt === "boolean" && hasDealt === false;

  if (!currentPlayerId || currentPlayerId !== playerId) {
    if (!(canStartGameWithoutTurn && currentPlayerId == null)) {
      // Turn changed while we waited; abort.
      return;
    }
  }

  const seat = game.players.find((s: Player) => s.id === playerId);
  if (!seat || seat.aiRuntime !== "backend") {
    // Seat no longer AI
    return;
  }

  if (game.winner) {
    return;
  }

  console.log(`AI turn starting for player ${playerId} in game ${gameId}`);

  // Build player-specific view (same as frontend gets for this player)
  const view = buildViewForPlayer(game, playerId);
  const showExceptionsInFrontend = config.llmShowExceptionsInFrontend;

  const { candidates } = getAiDecisionContext(gameId, game, view, playerId);

  // Let ai-policy module handle candidate enumeration + LLM selection
  let chosenIntent: ClientIntent | null = null;
  let timeoutId: NodeJS.Timeout | null = null;
  let aiPromise: Promise<ClientIntent | null> | null = null;
  const formatFatalMessage = (message: string, details?: string) => {
    if (!showExceptionsInFrontend || !details) return message;
    return `${message}\n\n${details}`;
  };

  try {
    if (LLM_TURN_TIMEOUT_MS <= 0) {
      chosenIntent = await chooseAiIntent(
        gameId,
        game,
        view,
        playerId,
        turnNumber,
        candidates
      );
    } else {
      aiPromise = chooseAiIntent(
        gameId,
        game,
        view,
        playerId,
        turnNumber,
        candidates
      );
      const timeoutPromise = new Promise<null>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new AiError(
              "timeout",
              `AI timed out after ${LLM_TURN_TIMEOUT_MS}ms while choosing move`
            )
          );
        }, LLM_TURN_TIMEOUT_MS);
      });

      chosenIntent = await Promise.race([aiPromise, timeoutPromise]);
    }
  } catch (err) {
    let aiError: AiError;

    if (err instanceof AiError) {
      aiError = err;
    } else {
      const errorDetail = err instanceof Error ? err.message : String(err);
      const isTimeout =
        errorDetail.toLowerCase().includes("timeout") ||
        errorDetail.toLowerCase().includes("timed out") ||
        errorDetail.toLowerCase().includes("deadline exceeded");

      if (isTimeout) {
        aiError = new AiError("timeout", errorDetail);
      } else if (err instanceof AiPolicyError) {
        aiError = new AiError("policy", err.message, err.details);
      } else {
        aiError = new AiError("unexpected", errorDetail);
      }
    }

    if (aiError.type === "timeout") {
      const randomCandidate =
        candidates.length > 0
          ? candidates[Math.floor(Math.random() * candidates.length)]
          : null;

      appendAiLogEntry({
        gameId,
        turnNumber,
        playerId,
        phase: "execution",
        level: "warn",
        message: `AI timed out. Selecting random move.`,
        details: {
          error: aiError.message,
          timeoutMs: LLM_TURN_TIMEOUT_MS,
          selectedCandidate: randomCandidate?.id,
          summary: randomCandidate?.summary,
        },
      });

      sendGameStatus(
        gameId,
        `AI for player ${playerId} timed out and thus a random move was chosen.`,
        "warning",
        "ai"
      );

      if (randomCandidate) {
        chosenIntent = randomCandidate.intent;
      }

      if (aiPromise) {
        aiPromise.catch((laterErr) => {
          console.error("AI choose intent rejected after timeout", laterErr);
        });
      }
    } else if (aiError.type === "policy") {
      appendAiLogEntry({
        gameId,
        turnNumber,
        playerId,
        phase: "execution",
        level: "error",
        message: `AI policy failed: ${aiError.message}`,
        details: showExceptionsInFrontend
          ? { error: aiError.details }
          : undefined,
      });

      emitFatalErrorEvent(
        gameId,
        formatFatalMessage(
          `AI for player ${playerId} failed to select a legal move.`,
          aiError.details
        ),
        "ai",
        broadcastStateCallback
      );
      return;
    } else {
      console.error("Unexpected error while choosing AI intent", err);
      appendAiLogEntry({
        gameId,
        turnNumber,
        playerId,
        phase: "execution",
        level: "error",
        message: `Unexpected error while choosing AI intent: ${aiError.message}`,
        details: showExceptionsInFrontend
          ? { error: aiError.message }
          : undefined,
      });
      emitFatalErrorEvent(
        gameId,
        formatFatalMessage(
          `AI for player ${playerId} failed unexpectedly while choosing a move.`,
          aiError.message
        ),
        "ai",
        broadcastStateCallback
      );
      return;
    }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }

  if (!chosenIntent) {
    console.log(`AI turn ended: no valid intent found for player ${playerId}`);
    appendAiLogEntry({
      gameId,
      turnNumber,
      playerId,
      phase: "execution",
      level: "error",
      message: "AI could not find any legal intent; treating as fatal.",
    });
    // No intent = AI completely stuck → treat as fatal for now.
    emitFatalErrorEvent(
      gameId,
      `AI for player ${playerId} could not find any legal moves.`,
      "ai",
      broadcastStateCallback
    );
    return;
  }

  console.log("AI turn: executing intent", { playerId, intent: chosenIntent });

  // Feed into the normal intent pipeline as if this player sent it
  const result = await handleClientIntent(
    gameId,
    playerId,
    chosenIntent,
    broadcastStateCallback
  );

  if (!result.success) {
    console.log("AI turn: intent execution FAILED", { playerId, result });

    appendAiLogEntry({
      gameId,
      turnNumber,
      playerId,
      phase: "execution",
      level: "error",
      message: "AI intent was rejected by validation: Unknown reason",
    });

    emitFatalErrorEvent(
      gameId,
      `AI for player ${playerId} produced an invalid move that was rejected by game validation.`,
      "ai",
      broadcastStateCallback
    );

    return;
  }

  console.log("AI turn: intent execution result", {
    playerId,
    success: result.success,
  });

  // Enforce a minimum LLM think time across the whole AI turn
  if (LLM_MIN_THINK_TIME_MS > 0) {
    const elapsed = Date.now() - startedAt;
    const remaining = LLM_MIN_THINK_TIME_MS - elapsed;
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }
}
