// backend/src/ai/ai-llm-policy.ts

import type {
  ClientIntent,
  GameView as PlayerGameView,
} from "../../../shared/schemas.js";
import { ClientIntentSchema } from "../../../shared/schemas.js";
import { buildAiMessages } from "../../../shared/src/ai/prompts.js";
import { parseAiChoice } from "../../../shared/src/ai/parser.js";
import type { AiIntentCandidate } from "./ai-policy.js";
import { appendAiLogEntry } from "./ai-log.js";
import {
  createChatModel,
  getPolicyLlmConfig,
} from "../llm/openaiCompatible.js";
import { getEnvironmentConfig } from "../config.js";
import { loadRulesForGame } from "../game-config.js";
import { createRulesMarkdownResolver } from "../../../shared/src/ai/rules-markdown.js";
import {
  collectErrorStrings,
  extractLlmErrorDetails,
  runLlmWithFallback,
} from "../../../shared/src/ai/llm-utils.js";

export interface AiPolicyInput {
  rulesId: string;
  playerId: string;
  view: PlayerGameView;
  candidates: AiIntentCandidate[];
  turnNumber: number;
}

// Some providers (e.g., certain Gemma deployments) reject system/developer
// instructions. Once detected, we globally stop sending system-role messages
// for policy calls until the process restarts.
let policyLlmAllowsSystemRole = true;
export const resolveRulesMarkdown = createRulesMarkdownResolver(
  async (rulesId) => loadRulesForGame(rulesId),
  {
    onError: (rulesId, err) => {
      console.warn(`[LLM] No rules markdown for rulesId="%s"`, rulesId, err);
    },
  }
);

export async function warmUpPolicyModel(): Promise<void> {
  if (!process.env.LLM_API_KEY || !process.env.LLM_MODEL) {
    console.log(
      "[warmUpPolicyModel] LLM_API_KEY or LLM_MODEL missing; skipping policy LLM warm-up"
    );
    return;
  }

  let cfg;
  try {
    cfg = getPolicyLlmConfig();
  } catch (err) {
    console.warn(
      "[warmUpPolicyModel] getPolicyLlmConfig failed; skipping warm-up",
      err
    );
    return;
  }

  const model = createChatModel(cfg);

  try {
    // We manually invoke here to test connectivity, bypassing the full fallback wrapper for simplicity,
    // or we could use the wrapper. For warm-up, a simple invoke is usually fine.
    // However, if we want to test system fallback logic, we should use callPolicyLlm.
    // But callPolicyLlm expects prompts.
    // Let's just use model.invoke directly as before for warmup.
    // But we need to handle the response format manually as before.

    const response = await model.invoke([
      {
        role: "user",
        content:
          "Universal card engine warm-up ping. Reply with a tiny JSON object to confirm readiness.",
      },
    ]);
    const content = extractContent(response);
    if (!content) throw new Error("No content in warmup response");

    console.log(`[warmUpPolicyModel] Policy LLM warmed up successfully`);
  } catch (err) {
    console.warn(`[warmUpPolicyModel] Policy LLM warm-up failed`, err);
  }
}

/**
 * Main entry point used by ai-policy.ts
 */
export async function chooseAiIntentWithLlm(
  input: AiPolicyInput
): Promise<AiIntentCandidate | null> {
  const { buildAiRequestPayload } = await import("./ai-policy.js");
  const { req, idMap } = await buildAiRequestPayload(input);

  const messages = buildAiMessages(req);
  const systemPrompt = messages.find((m) => m.role === "system")?.content ?? "";
  let userPromptObject: unknown = {};
  const userMessage = messages.find((m) => m.role === "user")?.content;
  if (userMessage) {
    try {
      userPromptObject = JSON.parse(userMessage);
    } catch {
      userPromptObject = userMessage;
    }
  }

  logPolicyRequest(input, messages);

  let content: string;
  try {
    content = await callPolicyLlm(
      systemPrompt,
      userPromptObject,
      (info: SystemFallbackInfo) => {
        appendAiLogEntry({
          gameId: input.view.gameId ?? "unknown",
          turnNumber: input.turnNumber,
          playerId: input.playerId,
          phase: "fallback",
          level: "warn",
          message: "System role unsupported; retrying without system role.",
          source: "backend",
          details: {
            kind: "system-fallback",
            ...info,
          },
        });
      }
    );
  } catch (err) {
    logPolicyError(input, err);
    throw err;
  }

  // Log the raw LLM response
  appendAiLogEntry({
    gameId: input.view.gameId ?? "unknown",
    turnNumber: input.turnNumber,
    playerId: input.playerId,
    phase: "llm-raw",
    level: "info",
    message: "Received raw AI policy response from LLM.",
    source: "backend",
    details: {
      kind: "llm-response-raw",
      content,
    },
  });

  const parsed = parseAiChoice(content);
  if (!parsed) {
    console.error("Failed to parse AI policy output:", content);
    appendAiLogEntry({
      gameId: input.view.gameId ?? "unknown",
      turnNumber: input.turnNumber,
      playerId: input.playerId,
      phase: "llm",
      level: "error",
      message:
        "Failed to parse AI policy output; falling back to default candidate.",
      details: { kind: "llm-response", content },
    });
    return null;
  }

  appendAiLogEntry({
    gameId: input.view.gameId ?? "unknown",
    turnNumber: input.turnNumber,
    playerId: input.playerId,
    phase: "llm-parsed",
    level: "info",
    message: "Parsed AI policy response.",
    source: "backend",
    details: {
      kind: "llm-response-parsed",
      parsed,
    },
  });

  const chosen = idMap.get(parsed.chosenCandidateId);

  if (!chosen) {
    console.warn(
      `AI policy returned unknown candidate id: ${parsed.chosenCandidateId}`
    );
    return null;
  }

  let safeIntent: ClientIntent;
  try {
    safeIntent = ClientIntentSchema.parse(chosen.intent);
  } catch {
    appendAiLogEntry({
      gameId: input.view.gameId ?? "unknown",
      turnNumber: input.turnNumber,
      playerId: input.playerId,
      phase: "llm",
      level: "warn",
      message: "LLM produced an invalid ClientIntent shape; skipping move.",
    });
    return null;
  }

  return { ...chosen, intent: safeIntent };
}

function maskApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey) return undefined;
  return "*".repeat(apiKey.length);
}

function buildPolicyUrl(baseUrl: string | undefined): string {
  const normalized = baseUrl ? baseUrl.replace(/\/?$/, "/") : "";
  return `${normalized || "https://api.openai.com/v1/"}chat/completions`;
}

function logPolicyRequest(input: AiPolicyInput, messages: unknown) {
  const cfg = getPolicyLlmConfig();
  appendAiLogEntry({
    gameId: input.view.gameId ?? "unknown",
    turnNumber: input.turnNumber,
    playerId: input.playerId,
    phase: "llm",
    level: "info",
    message: "Sending AI policy request to LLM.",
    source: "backend",
    details: {
      kind: "llm-request",
      url: buildPolicyUrl(cfg.baseUrl),
      params: {
        model: cfg.model,
        temperature: cfg.temperature ?? 0,
      },
      apiKeyMasked: maskApiKey(cfg.apiKey),
      messages,
    },
  });
}

function logPolicyError(input: AiPolicyInput, err: unknown) {
  const { llmShowExceptionsInFrontend } = getEnvironmentConfig();
  const cfg = getPolicyLlmConfig();
  const { status, statusText, responseBody, error } =
    extractLlmErrorDetails(err);
  appendAiLogEntry({
    gameId: input.view.gameId ?? "unknown",
    turnNumber: input.turnNumber,
    playerId: input.playerId,
    phase: "error",
    level: "error",
    message: "LLM policy request failed.",
    source: "backend",
    details: {
      kind: "llm-error",
      ...(llmShowExceptionsInFrontend
        ? {
            url: buildPolicyUrl(cfg.baseUrl),
            params: {
              model: cfg.model,
              temperature: cfg.temperature ?? 0,
            },
            status,
            statusText,
            error,
            responseBody,
          }
        : {}),
    },
  });
}

type SystemFallbackInfo = {
  errorMessage: string;
  status?: number;
  baseUrl?: string;
  modelId?: string;
};

async function callPolicyLlm(
  systemPrompt: string,
  userPromptObject: unknown,
  onSystemFallback?: (info: SystemFallbackInfo) => void
): Promise<string> {
  const cfg = getPolicyLlmConfig();
  const model = createChatModel(cfg);
  const userPrompt = formatMessageContent(userPromptObject);

  return runLlmWithFallback({
    systemPrompt,
    userPrompt,
    invoke: async (messages) => {
      // Map shared LlmMessage to what ChatOpenAI expects
      const langchainMessages = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const response = await model.invoke(langchainMessages);
      return extractContent(response);
    },
    systemRoleAllowed: policyLlmAllowsSystemRole,
    onSystemFallback: (err) => {
      policyLlmAllowsSystemRole = false;
      const { status, error } = extractLlmErrorDetails(err);
      const errorStrings = collectErrorStrings(err);
      const errorMessage = errorStrings.join(" ") || error || String(err);

      console.warn(
        `[LLM] Disabling system role for policy LLM calls after error: ${errorMessage}`
      );

      onSystemFallback?.({
        errorMessage,
        status,
        baseUrl: cfg.baseUrl,
        modelId: cfg.model,
      });
    },
    fallbackContext: {
      baseUrl: cfg.baseUrl,
      modelId: cfg.model,
    },
  });
}

function formatMessageContent(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function extractContent(response: { content: unknown }): string {
  const rawContent = response?.content;
  if (Array.isArray(rawContent)) {
    return rawContent
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && "text" in item) {
          return (item as { text?: string }).text ?? "";
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return String(rawContent ?? "");
}
