import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActiveGameSummary,
  AiRuntimePreference,
  AvailableGame,
  BackendRuntimeInfo,
  RuleEngineMode,
} from "../state";
import {
  fetchActiveGames,
  fetchAvailableGames,
  fetchServerConfig,
} from "../socket";

type SetState<T> = (update: T | ((prev: T) => T)) => void;

type UseLobbyDataOptions = {
  aiRuntimePreference: AiRuntimePreference;
  setAiRuntimePreference: SetState<AiRuntimePreference>;
  setAvailableGames: SetState<AvailableGame[]>;
  setActiveGames: SetState<ActiveGameSummary[]>;
  setRuleEngineMode: SetState<RuleEngineMode>;
  setServerAiEnabled: SetState<boolean>;
  setAiShowExceptions: SetState<boolean>;
  setBackendRuntime: SetState<BackendRuntimeInfo | null>;
  isLobbyView: boolean;
};

type UseLobbyDataResult = {
  isLobbyLoading: boolean;
  lobbyLoadError: string | null;
  refreshLobby: () => void;
};

export function useLobbyData({
  aiRuntimePreference,
  setAiRuntimePreference,
  setAvailableGames,
  setActiveGames,
  setRuleEngineMode,
  setServerAiEnabled,
  setAiShowExceptions,
  setBackendRuntime,
  isLobbyView,
}: UseLobbyDataOptions): UseLobbyDataResult {
  const [isLobbyLoading, setIsLobbyLoading] = useState(true);
  const [lobbyLoadError, setLobbyLoadError] = useState<string | null>(null);
  const lobbyRetryTimerRef = useRef<number | null>(null);
  const lobbyCancelledRef = useRef(false);

  const loadLobbyData = useCallback(async () => {
    setIsLobbyLoading(true);
    setLobbyLoadError(null);
    try {
      const [available, active, config] = await Promise.all([
        fetchAvailableGames(),
        fetchActiveGames(),
        fetchServerConfig(),
      ]);
      if (lobbyCancelledRef.current) return;
      setAvailableGames(available);
      setActiveGames(active);
      setRuleEngineMode(config.ruleEngineMode);

      const serverSupportsAi = config.serverAiEnabled ?? false;
      setServerAiEnabled(serverSupportsAi);
      // Game Log is always enabled for all games.
      // config.llmShowPromptsInFrontend determines if we get detailed AI internals for backend AI.
      setAiShowExceptions(config.llmShowExceptionsInFrontend ?? false);
      setBackendRuntime(config.backendRuntime ?? null);

      // Handle AI Runtime Preference Defaults
      const storedPref = window.localStorage.getItem("ai-runtime-preference");

      if (storedPref === null) {
        // No preference stored (new user): Set default based on server capability
        if (serverSupportsAi) {
          setAiRuntimePreference("backend");
        } else {
          setAiRuntimePreference("off");
        }
      } else {
        // Preference exists: Validate it against current server capabilities
        // If user wants backend but server doesn't support it, fall back to off
        if (!serverSupportsAi && aiRuntimePreference === "backend") {
          setAiRuntimePreference("off");
        }
      }

      setIsLobbyLoading(false);
    } catch (err) {
      if (lobbyCancelledRef.current) return;
      console.error("Failed to load lobby data; retrying shortly", err);
      const message =
        err instanceof Error ? err.message : "Unknown network error";
      setLobbyLoadError(message);
      if (lobbyRetryTimerRef.current) {
        clearTimeout(lobbyRetryTimerRef.current);
      }
      lobbyRetryTimerRef.current = window.setTimeout(() => {
        void loadLobbyData();
      }, 1500);
    }
  }, [
    aiRuntimePreference,
    setActiveGames,
    setAiShowExceptions,
    setAiRuntimePreference,
    setAvailableGames,
    setRuleEngineMode,
    setServerAiEnabled,
    setBackendRuntime,
  ]);

  useEffect(() => {
    lobbyCancelledRef.current = false;
    void loadLobbyData();

    return () => {
      lobbyCancelledRef.current = true;
      if (lobbyRetryTimerRef.current) {
        clearTimeout(lobbyRetryTimerRef.current);
      }
    };
  }, [loadLobbyData]);

  useEffect(() => {
    if (!isLobbyView) return;

    const intervalId = window.setInterval(async () => {
      if (document.hidden) return;
      try {
        const active = await fetchActiveGames();
        setActiveGames(active);
      } catch (err) {
        console.error("Failed to poll active games", err);
      }
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [isLobbyView, setActiveGames]);

  return {
    isLobbyLoading,
    lobbyLoadError,
    refreshLobby: () => {
      void loadLobbyData();
    },
  };
}
