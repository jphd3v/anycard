import {
  isSystemUnsupportedError,
  mergeSystemIntoUser,
} from "./system-fallback.js";

export type LlmMessage = { role: "system" | "user"; content: string };

export interface LlmErrorDetails {
  status?: number;
  statusText?: string;
  responseBody?: string;
  error?: string;
}

export function extractLlmErrorDetails(err: unknown): LlmErrorDetails {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyErr = err as any;

  // Try to extract status
  const status = anyErr?.status ?? anyErr?.response?.status;

  // Try to extract status text
  const statusText = anyErr?.statusText ?? anyErr?.response?.statusText;

  // Try to extract response body
  let responseBody: string | undefined;
  const body = anyErr?.body ?? anyErr?.response?.data ?? anyErr?.responseBody;
  if (body !== undefined) {
    if (typeof body === "string") {
      responseBody = body;
    } else {
      try {
        responseBody = JSON.stringify(body);
      } catch {
        responseBody = String(body);
      }
    }
  }

  // Try to extract error message
  let errorStr = "";
  if (err instanceof Error) {
    errorStr = err.message;
  } else if (typeof anyErr?.error === "string") {
    errorStr = anyErr.error;
  } else if (anyErr?.message) {
    errorStr = anyErr.message;
  } else {
    errorStr = String(err);
  }

  return { status, statusText, responseBody, error: errorStr };
}

export function collectErrorStrings(err: unknown): string[] {
  const parts: string[] = [];
  const push = (val: unknown) => {
    if (typeof val === "string" && val.trim()) parts.push(val);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyErr = err as any;
  push(err instanceof Error ? err.message : undefined);
  push(anyErr?.error);
  push(anyErr?.error?.message);
  push(anyErr?.body?.error?.message);
  push(anyErr?.response?.data?.error?.message);
  push(anyErr?.response?.data?.message);

  return parts;
}

export interface RunLlmOptions {
  systemPrompt: string;
  userPrompt: string;
  invoke: (messages: LlmMessage[]) => Promise<string>;
  onSystemFallback?: (error: unknown) => void;
  systemRoleAllowed?: boolean; // Default true

  // For isSystemUnsupportedError check
  fallbackContext?: {
    baseUrl?: string;
    modelId?: string;
  };
}

export async function runLlmWithFallback(
  options: RunLlmOptions
): Promise<string> {
  const {
    systemPrompt,
    userPrompt,
    invoke,
    onSystemFallback,
    systemRoleAllowed = true,
    fallbackContext,
  } = options;

  const runCall = async (allowSystem: boolean) => {
    const messages: LlmMessage[] = [];
    if (allowSystem && systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
      messages.push({ role: "user", content: userPrompt });
    } else {
      const content = systemPrompt
        ? mergeSystemIntoUser(systemPrompt, userPrompt)
        : userPrompt;
      messages.push({ role: "user", content });
    }
    return invoke(messages);
  };

  if (!systemRoleAllowed) {
    return runCall(false);
  }

  try {
    return await runCall(true);
  } catch (err) {
    // Check if we should fallback
    const { status, error } = extractLlmErrorDetails(err);
    const errorStrings = collectErrorStrings(err);
    const combinedError = errorStrings.join(" ") || error || "";

    const isUnsupported = isSystemUnsupportedError({
      errorMessage: combinedError,
      status,
      baseUrl: fallbackContext?.baseUrl,
      modelId: fallbackContext?.modelId,
    });

    if (isUnsupported) {
      onSystemFallback?.(err);
      return runCall(false);
    }

    throw err;
  }
}
