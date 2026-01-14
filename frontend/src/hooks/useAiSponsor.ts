import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { parseAiOutput } from "../../../shared/src/ai/parser";
import {
  extractLlmErrorDetails,
  runLlmWithFallback,
  type LlmMessage,
} from "../../../shared/src/ai/llm-utils";
import {
  aiShowExceptionsAtom,
  fatalErrorAtom,
  gameViewAtom,
  localAiConfigAtom,
  statusMessageAtom,
  toastAutoCloseEnabledAtom,
} from "../state";
import {
  fetchAiPrompt,
  logAiLlmError,
  logAiLlmParsed,
  logAiLlmRaw,
  sendClientIntent,
} from "../socket";
import type { ClientIntent } from "../../../shared/schemas";
import { AiError } from "../../../shared/src/ai/types";

let policyLlmAllowsSystemRole = true;

const TURN_TIMEOUT_MS =
  Number(import.meta.env.VITE_LLM_TURN_TIMEOUT_MS) || 10000;
const MIN_THINK_TIME_MS =
  Number(import.meta.env.VITE_LLM_MIN_THINK_TIME_MS) || 300;
const IS_LOGGING_ENABLED = import.meta.env.VITE_LLM_LOGGING_ENABLED === "true";

export function useAiSponsor() {
  const view = useAtomValue(gameViewAtom);
  const aiConfig = useAtomValue(localAiConfigAtom);
  const aiShowExceptions = useAtomValue(aiShowExceptionsAtom);
  const toastAutoCloseEnabled = useAtomValue(toastAutoCloseEnabledAtom);
  const setFatalError = useSetAtom(fatalErrorAtom);
  const addStatusMessage = useSetAtom(statusMessageAtom);
  const processingRef = useRef(false);
  const lastLogRef = useRef<string | null>(null);
  const lastRunKeyRef = useRef<Map<string, string>>(new Map());
  const lastDuplicateWarnedKeyRef = useRef<Map<string, string>>(new Map());
  const candidateKey = (() => {
    if (!view?.currentSeatId) return "";
    const aiView = view.sponsoredAiViews?.[view.currentSeatId] ?? view;
    return aiView.aiCandidatesForCurrentTurn?.map((c) => c.id).join("|") ?? "";
  })();

  useEffect(() => {
    // Clear stale errors when not actively sponsoring an AI seat.
    if (!view || !view.currentSeatId || view.winner) {
      return;
    }
    if (!aiConfig.enabled) {
      if (lastLogRef.current !== "disabled") {
        lastLogRef.current = "disabled";
      }
      if (view?.currentSeatId) {
        lastRunKeyRef.current.delete(view.currentSeatId);
        lastDuplicateWarnedKeyRef.current.delete(view.currentSeatId);
      }
      return;
    }
    if (processingRef.current) return;

    const seat = view.seats?.find((s) => s.seatId === view.currentSeatId);
    if (!seat) {
      return;
    }
    if (!seat.isAiControlledByYou) {
      if (lastLogRef.current !== "not-sponsor") {
        lastLogRef.current = "not-sponsor";
      }
      if (view?.currentSeatId) {
        lastRunKeyRef.current.delete(view.currentSeatId);
        lastDuplicateWarnedKeyRef.current.delete(view.currentSeatId);
      }
      return;
    }
    if (seat.aiRuntime !== "frontend") {
      if (lastLogRef.current !== "not-frontend") {
        lastLogRef.current = "not-frontend";
      }
      if (view?.currentSeatId) {
        lastRunKeyRef.current.delete(view.currentSeatId);
        lastDuplicateWarnedKeyRef.current.delete(view.currentSeatId);
      }
      return;
    }

    const aiView = view.sponsoredAiViews?.[seat.seatId] ?? view;
    const candidates = aiView.aiCandidatesForCurrentTurn ?? [];
    if (candidates.length === 0) {
      if (lastLogRef.current !== "no-candidates") {
        lastLogRef.current = "no-candidates";
      }
      return;
    }

    const runKey = [
      view.gameId,
      seat.seatId,
      candidateKey,
      String(view.stateVersion ?? 0),
    ].join("|");

    const lastRunKey = lastRunKeyRef.current.get(seat.seatId);
    if (lastRunKey === runKey) {
      const lastWarnedKey = lastDuplicateWarnedKeyRef.current.get(seat.seatId);
      if (lastWarnedKey !== runKey) {
        lastDuplicateWarnedKeyRef.current.set(seat.seatId, runKey);
        const id = Date.now() + Math.random();
        addStatusMessage((prev) => [
          {
            id,
            message: `Possible duplicate AI turn detected for seat ${seat.seatId}. Continuing anyway.`,
            tone: "warning",
            source: "app",
          },
          ...prev,
        ]);
        if (toastAutoCloseEnabled) {
          setTimeout(() => {
            addStatusMessage((prev) => prev.filter((m) => m.id !== id));
          }, 3000);
        }
      }
    }
    lastRunKeyRef.current.set(seat.seatId, runKey);

    const runAi = async () => {
      processingRef.current = true;
      const stateVersion = view.stateVersion ?? 0;
      try {
        // Fetch pre-built prompt from backend
        const promptPayload = await fetchAiPrompt(
          view.gameId,
          seat.seatId,
          stateVersion
        );

        if (promptPayload.stale) {
          if (IS_LOGGING_ENABLED) {
            console.debug("[AI] Ignoring stale AI prompt response", {
              seat: seat.seatId,
              requestedStateVersion: promptPayload.requestedStateVersion,
              stateVersion: promptPayload.stateVersion,
            });
          }
          return;
        }
        if (promptPayload.error) {
          throw new Error(promptPayload.error);
        }

        const { messages, context } = promptPayload;
        if (!messages || !context) {
          throw new Error("AI prompt payload incomplete");
        }

        const systemPrompt =
          (
            messages.find(
              (m: unknown) => (m as Record<string, unknown>).role === "system"
            ) as Record<string, unknown> | undefined
          )?.content ?? "";

        const userPrompt =
          (
            messages.find(
              (m: unknown) => (m as Record<string, unknown>).role === "user"
            ) as Record<string, unknown> | undefined
          )?.content ?? "";

        if (IS_LOGGING_ENABLED) {
          console.debug(
            "[AI] Frontend sponsor running AI",
            seat.seatId,
            "candidates=",
            context.candidates.length
          );
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        if (aiConfig.apiKey && aiConfig.apiKey.trim().length > 0) {
          headers.Authorization = `Bearer ${aiConfig.apiKey}`;
        }

        const invokeLlm = async (
          messagesToSend: LlmMessage[]
        ): Promise<string> => {
          // LLM request logging is handled by backend if desired,
          // but we can add a simple client-side console.debug here.
          if (IS_LOGGING_ENABLED) {
            console.debug("[AI] Sending LLM request", {
              messagesToSend,
            });
          }

          const controller = new AbortController();
          const timeoutMs = TURN_TIMEOUT_MS;
          const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

          try {
            const res = await fetch(`${aiConfig.baseUrl}/chat/completions`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                model: aiConfig.model,
                messages: messagesToSend,
                temperature: 0,
              }),
              signal: controller.signal,
            });

            const responseBody = await res.text();

            if (!res.ok) {
              const httpError = new Error(
                `AI HTTP error: ${res.status} ${res.statusText}`
              ) as Error & {
                status?: number;
                statusText?: string;
                responseBody?: string;
              };

              httpError.status = res.status;
              httpError.statusText = res.statusText;
              httpError.responseBody = responseBody;

              throw httpError;
            }

            let data: unknown;
            try {
              data = JSON.parse(responseBody);
            } catch {
              const parseError = new Error(
                "AI response invalid JSON"
              ) as Error & {
                responseBody?: string;
              };
              parseError.responseBody = responseBody;
              throw parseError;
            }

            const content = (
              data as { choices?: Array<{ message?: { content?: string } }> }
            )?.choices?.[0]?.message?.content;

            if (!content) {
              const missingError = new Error(
                "AI response missing content"
              ) as Error & {
                responseBody?: string;
              };
              missingError.responseBody = responseBody;
              throw missingError;
            }

            return content;
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
              throw new AiError(
                "timeout",
                `AI turn timed out after ${timeoutMs}ms`
              );
            }
            throw err;
          } finally {
            clearTimeout(timeoutId);
          }
        };

        const content = await runLlmWithFallback({
          systemPrompt: systemPrompt as string,
          userPrompt: userPrompt as string,
          invoke: invokeLlm,
          systemRoleAllowed: policyLlmAllowsSystemRole,
          onSystemFallback: () => {
            policyLlmAllowsSystemRole = false;
            if (IS_LOGGING_ENABLED) {
              console.debug(
                "[AI] System role unsupported; disabling for future calls"
              );
            }
          },
          fallbackContext: {
            baseUrl: aiConfig.baseUrl,
            modelId: aiConfig.model,
          },
        });

        logAiLlmRaw(view.gameId, seat.seatId, stateVersion, content);

        const output = parseAiOutput(content);

        if (!output) {
          throw new AiError(
            "policy",
            "AI response could not be parsed",
            content
          );
        }

        logAiLlmParsed(view.gameId, seat.seatId, stateVersion, output);

        // Map output.id back to original intent from our backend-provided context

        const action = context.candidates.find((c: unknown) => {
          const candidate = c as Record<string, unknown>;
          return candidate.id === output.id;
        }) as Record<string, unknown> | undefined;

        if (!action) {
          throw new AiError(
            "policy",
            `AI chose invalid candidate id: ${output.id ?? "unknown"}`
          );
        }

        const intent = action.intent;
        if (intent && typeof intent === "object" && "type" in intent) {
          sendClientIntent(intent as ClientIntent);
        } else {
          throw new AiError("policy", "AI intent payload invalid");
        }
      } catch (err: unknown) {
        let aiError: AiError;
        const extracted = extractLlmErrorDetails(err);

        if (err instanceof AiError) {
          aiError = err;
        } else {
          const detail = err instanceof Error ? err.message : String(err);

          const isTimeout =
            extracted.status === 408 ||
            extracted.status === 504 ||
            detail.toLowerCase().includes("timeout") ||
            detail.toLowerCase().includes("timed out") ||
            detail.toLowerCase().includes("deadline exceeded");

          if (isTimeout) {
            aiError = new AiError("timeout", detail);
          } else {
            aiError = new AiError("unexpected", detail, extracted.responseBody);
          }
        }

        console.error("Frontend AI failed:", aiError);

        logAiLlmError(view.gameId, seat.seatId, stateVersion, {
          ...(aiShowExceptions
            ? {
                url: buildPolicyUrl(aiConfig.baseUrl),
                params: {
                  model: aiConfig.model,
                  temperature: 0,
                },
                error: aiError.message,
                details: aiError.details,
                status: extracted.status,
                statusText: extracted.statusText,
                responseBody: extracted.responseBody,
              }
            : {}),
        });

        if (aiError.type === "timeout" && candidates.length > 0) {
          const randomCandidate =
            candidates[Math.floor(Math.random() * candidates.length)];
          const toastId = Date.now() + Math.random();
          addStatusMessage((prev) => [
            {
              id: toastId,
              message: `AI for player ${seat.seatId} timed out and thus a random move was chosen.`,
              tone: "warning",
              source: "ai",
            },
            ...prev,
          ]);
          if (toastAutoCloseEnabled) {
            setTimeout(() => {
              addStatusMessage((prev) => prev.filter((m) => m.id !== toastId));
            }, 3750);
          }

          if (
            randomCandidate.intent &&
            typeof randomCandidate.intent === "object"
          ) {
            sendClientIntent(randomCandidate.intent as ClientIntent);
            return;
          }
        }

        const formatFatalMessage = (message: string, details?: string) => {
          if (!aiShowExceptions || !details) return message;
          return `${message}\n\n${details}`;
        };

        setFatalError({
          message: formatFatalMessage(
            `AI for player ${seat.seatId} failed while choosing a move.`,
            aiError.message
          ),
          source: "ai",
        });
      } finally {
        processingRef.current = false;
      }
    };

    const timer = setTimeout(runAi, MIN_THINK_TIME_MS);
    return () => clearTimeout(timer);
  }, [
    aiConfig.apiKey,
    aiConfig.baseUrl,
    aiConfig.enabled,
    aiConfig.model,
    aiShowExceptions,
    addStatusMessage,
    setFatalError,
    toastAutoCloseEnabled,
    view,
    view?.currentSeatId,
    view?.gameId,
    view?.rulesId,
    view?.seats,
    view?.winner,
    candidateKey,
  ]);
}

function buildPolicyUrl(baseUrl: string): string {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${normalized}chat/completions`;
}
