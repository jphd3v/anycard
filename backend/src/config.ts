// backend/src/config.ts
// Centralized environment configuration with defaults
import dotenv from "dotenv";

// Load environment variables early so that any module importing config picks up .env values.
dotenv.config();

export interface EnvironmentConfig {
  port: number;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel: string | undefined;
  llmTemperature: number;
  llmLoggingEnabled: boolean;
  llmShowPromptsInFrontend: boolean;
  llmStripOpenaiDefaults: boolean;
  llmTurnTimeoutMs: number;
  llmMinThinkTimeMs: number;
  clientOrigins: string[];
  backendAiEnabled: boolean;
  llmPolicyMode: "llm" | "firstCandidate";
  llmShowExceptionsInFrontend: boolean;
  isTestEnvironment: boolean;
}

function parseBooleanEnv(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

export function getEnvironmentConfig(): EnvironmentConfig {
  // Allow multiple origins from env, comma-separated, or fall back to dev defaults.
  // No "*" wildcard.
  const DEFAULT_DEV_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ];

  return {
    port: Number(process.env.PORT ?? 3000),
    llmBaseUrl: process.env.LLM_BASE_URL,
    llmApiKey: process.env.LLM_API_KEY,
    llmModel: process.env.LLM_MODEL,
    llmTemperature:
      process.env.LLM_TEMPERATURE !== undefined
        ? Number(process.env.LLM_TEMPERATURE)
        : 0,
    llmLoggingEnabled: parseBooleanEnv(process.env.LLM_LOGGING_ENABLED),
    llmShowPromptsInFrontend: parseBooleanEnv(
      process.env.LLM_SHOW_PROMPTS_IN_FRONTEND
    ),
    llmStripOpenaiDefaults: process.env.LLM_STRIP_OPENAI_DEFAULTS !== "false",
    llmTurnTimeoutMs: Number(process.env.LLM_TURN_TIMEOUT_MS ?? 10000),
    llmMinThinkTimeMs:
      process.env.LLM_MIN_THINK_TIME_MS !== undefined
        ? Number(process.env.LLM_MIN_THINK_TIME_MS)
        : 300,
    clientOrigins:
      process.env.CLIENT_ORIGIN?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? DEFAULT_DEV_ORIGINS,
    backendAiEnabled: process.env.BACKEND_LLM_ENABLED === "true",
    llmPolicyMode: (process.env.LLM_POLICY_MODE === "firstCandidate"
      ? "firstCandidate"
      : "llm") as "llm" | "firstCandidate",
    llmShowExceptionsInFrontend: parseBooleanEnv(
      process.env.LLM_SHOW_EXCEPTIONS_IN_FRONTEND
    ),
    isTestEnvironment:
      process.env.NODE_ENV === "test" ||
      process.argv.some((arg) => arg.includes("test")) ||
      // Detect when running under Playwright or other test environments
      Boolean(process.env.PLAYWRIGHT_TEST_BASE_URL) ||
      process.env.PORT === "3010", // Playwright uses port 3010 for tests
  };
}

export function getEnvironmentVariablesInfo(): Array<{
  key: string;
  value: string;
  defaultValue: string;
  isSet: boolean;
}> {
  const config = getEnvironmentConfig();

  return [
    {
      key: "PORT",
      value: String(process.env.PORT ?? config.port),
      defaultValue: "3000",
      isSet: Boolean(process.env.PORT),
    },
    {
      key: "LLM_BASE_URL",
      value: process.env.LLM_BASE_URL || "",
      defaultValue: "https://api.openai.com/v1/",
      isSet: Boolean(process.env.LLM_BASE_URL),
    },
    {
      key: "LLM_API_KEY",
      value: process.env.LLM_API_KEY ? "[SET]" : "[NOT SET]",
      defaultValue: "[OPTIONAL]",
      isSet: Boolean(process.env.LLM_API_KEY),
    },
    {
      key: "LLM_MODEL",
      value: process.env.LLM_MODEL || "",
      defaultValue: "[REQUIRED]",
      isSet: Boolean(process.env.LLM_MODEL),
    },
    {
      key: "LLM_TEMPERATURE",
      value: String(process.env.LLM_TEMPERATURE ?? config.llmTemperature),
      defaultValue: "0",
      isSet: Boolean(process.env.LLM_TEMPERATURE),
    },
    {
      key: "LLM_LOGGING_ENABLED",
      value: String(
        process.env.LLM_LOGGING_ENABLED ??
          (config.llmLoggingEnabled ? "true" : "false")
      ),
      defaultValue: "false",
      isSet: Boolean(process.env.LLM_LOGGING_ENABLED),
    },
    {
      key: "LLM_SHOW_PROMPTS_IN_FRONTEND",
      value: String(
        process.env.LLM_SHOW_PROMPTS_IN_FRONTEND ??
          (config.llmShowPromptsInFrontend ? "true" : "false")
      ),
      defaultValue: "false",
      isSet: Boolean(process.env.LLM_SHOW_PROMPTS_IN_FRONTEND),
    },
    {
      key: "LLM_STRIP_OPENAI_DEFAULTS",
      value: String(
        process.env.LLM_STRIP_OPENAI_DEFAULTS ??
          (config.llmStripOpenaiDefaults ? "true" : "false")
      ),
      defaultValue: "true",
      isSet: Boolean(process.env.LLM_STRIP_OPENAI_DEFAULTS),
    },
    {
      key: "LLM_TURN_TIMEOUT_MS",
      value: String(process.env.LLM_TURN_TIMEOUT_MS ?? config.llmTurnTimeoutMs),
      defaultValue: "10000",
      isSet: Boolean(process.env.LLM_TURN_TIMEOUT_MS),
    },
    {
      key: "LLM_MIN_THINK_TIME_MS",
      value: String(
        process.env.LLM_MIN_THINK_TIME_MS ?? config.llmMinThinkTimeMs
      ),
      defaultValue: "300",
      isSet: Boolean(process.env.LLM_MIN_THINK_TIME_MS),
    },
    {
      key: "CLIENT_ORIGIN",
      value: process.env.CLIENT_ORIGIN || "[DEFAULT]",
      defaultValue: "http://localhost:5173,http://127.0.0.1:5173",
      isSet: Boolean(process.env.CLIENT_ORIGIN),
    },
    {
      key: "BACKEND_LLM_ENABLED",
      value: process.env.BACKEND_LLM_ENABLED || "false",
      defaultValue: "false",
      isSet: process.env.BACKEND_LLM_ENABLED === "true",
    },
    {
      key: "LLM_POLICY_MODE",
      value: process.env.LLM_POLICY_MODE || "llm",
      defaultValue: "llm",
      isSet: Boolean(process.env.LLM_POLICY_MODE),
    },
    {
      key: "LLM_SHOW_EXCEPTIONS_IN_FRONTEND",
      value: process.env.LLM_SHOW_EXCEPTIONS_IN_FRONTEND || "false",
      defaultValue: "false",
      isSet: Boolean(process.env.LLM_SHOW_EXCEPTIONS_IN_FRONTEND),
    },
  ];
}

export function isServerAiEnabled(): boolean {
  const cfg = getEnvironmentConfig();
  return cfg.backendAiEnabled && Boolean(cfg.llmBaseUrl);
}
