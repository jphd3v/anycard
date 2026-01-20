import http from "node:http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import dotenv from "dotenv";
import {
  initSocket,
  getActiveGameSummaries,
  getGameSummary,
  closeGameSession,
} from "./socket.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_GAME_PLUGINS } from "./rules/registry.js";
import { loadGameMeta } from "./rules/meta.js";
import { RULE_ENGINE_MODE } from "./rule-engine.js";
import { resolveRulesDir } from "./util/rules-path.js";
import { warmUpPolicyModel } from "./ai/ai-llm-policy.js";
import {
  getEnvironmentConfig,
  getEnvironmentVariablesInfo,
  isServerAiEnabled,
} from "./config.js";

dotenv.config();

// Get the project root directory (two levels up from this file)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = getEnvironmentConfig();
const PORT = config.port;

const CLIENT_ORIGINS = config.clientOrigins;

const app = express();
app.use(
  cors({
    origin: CLIENT_ORIGINS,
  })
);
const RULES_DIR = resolveRulesDir(__dirname);
app.use("/rules", express.static(RULES_DIR));

app.get("/games", (_req, res) => {
  const games = ALL_GAME_PLUGINS.map((plugin) => {
    const meta = loadGameMeta(plugin.id);
    return {
      id: plugin.id,
      name: meta.gameName ?? plugin.gameName,
      description: meta.description ?? plugin.description ?? "",
      players: meta.players,
      category: meta.category,
    };
  });
  res.json({ games });
});

app.get("/active-games", (_req, res) => {
  const games = getActiveGameSummaries();
  res.json({ games });
});

app.get("/active-games/:gameId", (req, res) => {
  const { gameId } = req.params;
  const info = getGameSummary(gameId);
  if (!info) {
    res.status(404).json({ ok: false, message: "Game not found" });
    return;
  }
  res.json({ ok: true, game: info });
});

app.delete("/active-games/:gameId", (req, res) => {
  const { gameId } = req.params;
  if (typeof gameId !== "string" || gameId.trim() === "") {
    res.status(400).json({ ok: false, message: "Invalid game id" });
    return;
  }

  const closed = closeGameSession(io, gameId);
  if (!closed) {
    res.status(404).json({ ok: false, message: "Game not found" });
    return;
  }

  res.json({ ok: true });
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/config", (_req, res) => {
  res.json({
    ruleEngineMode: RULE_ENGINE_MODE,
    serverAiEnabled: isServerAiEnabled(),
    llmShowPromptsInFrontend: config.llmShowPromptsInFrontend,
    llmShowExceptionsInFrontend: config.llmShowExceptionsInFrontend,
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGINS,
  },
  transports: ["websocket"],
});

initSocket(io);

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`[Startup] Rule engine mode: ${RULE_ENGINE_MODE}`);

  // Log environment variables
  console.log(`[Environment] Configuration:`);
  const envVarsInfo = getEnvironmentVariablesInfo();
  envVarsInfo.forEach(({ key, isSet }) => {
    console.log(`  ${key} ${isSet ? "(set)" : "(default)"}`);
  });

  // Skip LLM warm-up during tests or if AI is disabled to avoid unnecessary failures
  if (!config.isTestEnvironment && isServerAiEnabled()) {
    (async () => {
      console.log("[Startup] Warming up policy LLM once");
      await warmUpPolicyModel().catch((err) => {
        console.warn("[Startup] Policy LLM warm-up failed", err);
      });
    })().catch((err) => {
      console.warn("[Startup] Policy LLM warm-up task failed", err);
    });
  } else if (config.isTestEnvironment) {
    console.log("[Startup] Skipping LLM warm-up in test environment");
  } else {
    console.log("[Startup] Skipping LLM warm-up because server AI is disabled");
  }
});
