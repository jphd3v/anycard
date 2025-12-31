// backend/src/llm/openaiCompatible.ts
import { ChatOpenAI } from "@langchain/openai";
import { getEnvironmentConfig } from "../config.js";

export interface OpenAiCompatibleConfig {
  baseUrl?: string; // if undefined => official api.openai.com
  apiKey: string;
  model: string;
  temperature?: number;
}

function isOpenAiBaseUrl(url: string | undefined): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  return lower.includes("api.openai.com") || lower.includes("openai.com");
}

function normalizeBaseUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.endsWith("/") ? url : `${url}/`;
}

function removeContentLength(
  headers: HeadersInit | undefined
): HeadersInit | undefined {
  if (!headers) return headers;
  const copy = new Headers(headers as HeadersInit);
  copy.delete("content-length");
  copy.delete("Content-Length");
  return copy;
}

export function getPolicyLlmConfig(): OpenAiCompatibleConfig {
  const config = getEnvironmentConfig();

  // For required fields, check if they're set in env - otherwise throw error
  const apiKey =
    config.llmApiKey ||
    (() => {
      if (!isOpenAiBaseUrl(config.llmBaseUrl)) {
        return "local";
      }
      throw new Error("Missing required env var: LLM_API_KEY");
    })();
  const model =
    config.llmModel ||
    (() => {
      throw new Error("Missing required env var: LLM_MODEL");
    })();

  return {
    baseUrl: config.llmBaseUrl,
    apiKey,
    model,
    temperature: config.llmTemperature,
  };
}

export function createChatModel(cfg: OpenAiCompatibleConfig): ChatOpenAI {
  const config = getEnvironmentConfig();
  const normalizedBaseUrl = normalizeBaseUrl(cfg.baseUrl);
  const enableLogging = config.llmDebugHttp;
  const enableSanitize = process.env.LLM_STRIP_OPENAI_DEFAULTS !== "0";
  const instrumentedFetch = createInstrumentedFetch({
    enableLogging,
    enableSanitize,
  });

  const options = {
    model: cfg.model,
    temperature: cfg.temperature ?? 0,
    apiKey: cfg.apiKey,
    configuration: {
      ...(normalizedBaseUrl
        ? { baseURL: normalizedBaseUrl, basePath: normalizedBaseUrl }
        : {}),
      ...(instrumentedFetch ? { fetch: instrumentedFetch } : {}),
    },
  };

  console.log("[LLM] Creating ChatOpenAI client", {
    model: cfg.model,
    baseURL: normalizedBaseUrl ?? "https://api.openai.com/v1/",
    temperature: cfg.temperature ?? 0,
    logging: Boolean(enableLogging),
    sanitizeDefaults: Boolean(enableSanitize),
  });

  return new ChatOpenAI(options as ConstructorParameters<typeof ChatOpenAI>[0]);
}

type InstrumentOptions = {
  enableLogging: boolean;
  enableSanitize: boolean;
};

function stripUnsupportedOpenAiFields(
  body: unknown
): { json: string; sanitized: boolean; snippet: string } | null {
  if (typeof body !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    let sanitized = false;
    for (const key of ["frequency_penalty", "presence_penalty"]) {
      if (key in parsed) {
        delete parsed[key];
        sanitized = true;
      }
    }
    const json = JSON.stringify(parsed);
    const snippet = json.slice(0, 500);
    return { json, sanitized, snippet };
  } catch {
    return null;
  }
}

function createInstrumentedFetch(opts: InstrumentOptions) {
  const { enableLogging, enableSanitize } = opts;
  const hasFetch = typeof fetch === "function";
  if (!hasFetch) {
    return undefined;
  }

  // Only wrap if we need logging or sanitization; otherwise let ChatOpenAI use default fetch
  if (!enableLogging && !enableSanitize) {
    return undefined;
  }

  return async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    let requestInit = init;
    let bodySnippet = "";
    let sanitized = false;
    let bodyLength = 0;

    if (enableSanitize && init?.body) {
      const stripped = stripUnsupportedOpenAiFields(init.body);
      if (stripped) {
        sanitized = stripped.sanitized;
        bodySnippet = stripped.snippet;
        bodyLength = stripped.json.length;
        requestInit = {
          ...init,
          body: stripped.json,
          headers: removeContentLength(init.headers),
        };
      }
    }

    if (enableLogging) {
      try {
        const url = typeof input === "string" ? input : input.toString();
        const method = requestInit?.method ?? "GET";
        if (!bodySnippet) {
          const body =
            typeof requestInit?.body === "string"
              ? requestInit.body
              : requestInit?.body instanceof Buffer
                ? `<Buffer length=${requestInit.body.length}>`
                : requestInit?.body
                  ? "<non-string body>"
                  : "";
          bodyLength = typeof body === "string" ? body.length : bodyLength;
          bodySnippet =
            typeof body === "string" ? body.slice(0, 2000) : String(body);
        }

        console.log("[LLM HTTP] request", {
          method,
          url,
          bodySnippet,
          bodyLength,
          sanitized,
        });
      } catch (err) {
        console.warn("[LLM HTTP] failed to log request pre-flight", err);
      }
    }

    const response = await fetch(input as RequestInfo | URL, requestInit);

    if (enableLogging) {
      try {
        const clone = response.clone();
        const text = await clone.text();
        console.log("[LLM HTTP] response", {
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          bodySnippet: text.slice(0, 2000),
        });
      } catch (err) {
        console.warn("[LLM HTTP] failed to log response", err);
      }
    }

    return response;
  };
}
