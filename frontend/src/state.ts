import { atom } from "jotai";
import { atomWithImmer } from "jotai-immer";
import { atomWithStorage, createJSONStorage } from "jotai/utils";
import { DEFAULT_CARD_SET, type CardSetId } from "./cardSets";
import type { GameView, SeatStatus } from "../../shared/schemas";
import type { AiLogEntry } from "../../shared/ai-log";
export type { AiLogEntry };

export type AvailableGame = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  minPlayers?: number;
  maxPlayers?: number;
};

export type ActiveGameSummary = {
  gameId: string;
  rulesId: string;
  numSeats: number;
  numOccupiedSeats: number;
  numSpectators: number;
  hasWinner: boolean;
  roomType: "demo" | "public";
  status: "waiting" | "playing" | "finished";
};

export type GameSummary = {
  gameId: string;
  rulesId: string;
  gameName: string;
  numSeats: number;
  numOccupiedSeats: number;
  numSpectators: number;
  hasWinner: boolean;
  roomType: "demo" | "public" | "private";
  players: { id: string; name?: string; occupied: boolean }[];
  seed?: string;
  status: "waiting" | "playing" | "finished";
};

export type RecentGameEntry = {
  gameId: string;
  rulesId: string;
  roomType: "demo" | "public" | "private";
  lastRole: "player" | "spectator";
  lastPlayerId: string;
  lastJoinedAt: number;
};

export type RuleEngineMode = "code";
export type AiRuntimePreference = "backend" | "frontend" | "off";

export type StatusTone = "success" | "error" | "neutral" | "warning";
export type StatusSource = "app" | "engine" | "ai";
export type ThemeSetting = "system" | "light" | "dark";

export interface FatalErrorState {
  message: string;
  source?: "ai" | "rules" | "engine";
}

export type StatusMessage = {
  id: number;
  tone: StatusTone;
  message: string;
  source: StatusSource;
};

export const playerIdAtom = atomWithStorage<string | null>("player-id", null);
export const gameIdAtom = atom<string>("");
export const statusMessageAtom = atom<StatusMessage[]>([]);
export const seatStatusAtom = atom<SeatStatus[]>([]);
export const roomSeedAtom = atom<string | null>(null);
export const ruleEngineModeAtom = atom<RuleEngineMode>("code");
export const isConnectedAtom = atom<boolean>(true);
export const rulesIdAtom = atom<string | null>(null);
export const activeTransitionCardIdsAtom = atom<Set<number> | null>(null);
export const cardSetAtom = atom<CardSetId>(DEFAULT_CARD_SET);

// Transient UI highlights for “what just happened?”
export const highlightedActionIdAtom = atom<string | null>(null);
export const highlightedActionLabelAtom = atom<string | null>(null);
export const highlightedScoreboardCellsAtom = atom<Record<string, string[]>>(
  {}
);

export const gameViewAtom = atomWithImmer<GameView | null>(null);
export const isEvaluatingMoveAtom = atom(false);

export const availableGamesAtom = atomWithImmer<AvailableGame[]>([]);

export const activeGamesAtom = atomWithImmer<ActiveGameSummary[]>([]);
export const recentGamesAtom = atomWithStorage<RecentGameEntry[]>(
  "recent-games",
  []
);

export const aiLogAtom = atom<AiLogEntry[]>([]);
export const aiLogVisibleAtom = atom(false);
export const isMenuOpenAtom = atom(false);
export const isActionsOpenAtom = atom(false);
export const isScoreboardOpenAtom = atom(false);

export const fatalErrorAtom = atom<FatalErrorState | null>(null);

export const allSeatsJoinedAtom = atom((get) => {
  const seats = get(seatStatusAtom);
  if (seats.length === 0) return false;
  return seats.every((s) => {
    const runtime = s.aiRuntime ?? (s.isAi ? "backend" : "none");
    return s.occupied || runtime !== "none"; // AI seats also count as joined
  });
});

export const allSeatsAutomatedAtom = atom((get) => {
  const seats = get(seatStatusAtom);
  if (seats.length === 0) return false;
  return seats.every((s) => {
    const runtime = s.aiRuntime ?? (s.isAi ? "backend" : "none");
    return runtime !== "none";
  });
});

export interface LocalAiConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const IS_BROWSER_LLM_ENABLED =
  import.meta.env.VITE_BROWSER_LLM_ENABLED === "true";

// baseUrl and model are stored in localStorage to persist across sessions.
const persistentLocalAiConfigAtom = atomWithStorage<
  Omit<LocalAiConfig, "apiKey">
>("local-ai-config", {
  enabled: IS_BROWSER_LLM_ENABLED,
  baseUrl: import.meta.env.VITE_LLM_BASE_URL || "",
  model: import.meta.env.VITE_LLM_MODEL || "",
});

// apiKey is stored in sessionStorage for better security.
const sessionAiApiKeyAtom = atomWithStorage<string>(
  "local-ai-api-key",
  import.meta.env.VITE_LLM_API_KEY || "",
  createJSONStorage(() => sessionStorage)
);

export const localAiConfigAtom = atom<
  LocalAiConfig,
  [LocalAiConfig | ((prev: LocalAiConfig) => LocalAiConfig)],
  void
>(
  (get) => ({
    ...get(persistentLocalAiConfigAtom),
    apiKey: get(sessionAiApiKeyAtom),
  }),
  (get, set, update) => {
    const prev = {
      ...get(persistentLocalAiConfigAtom),
      apiKey: get(sessionAiApiKeyAtom),
    };
    const newValue = typeof update === "function" ? update(prev) : update;
    const { apiKey, ...persistent } = newValue;
    set(persistentLocalAiConfigAtom, persistent);
    set(sessionAiApiKeyAtom, apiKey);
  }
);

export const aiRuntimePreferenceAtom = atomWithStorage<AiRuntimePreference>(
  "ai-runtime-preference",
  "off"
);

export const serverAiEnabledAtom = atom<boolean>(false);
export const aiShowExceptionsAtom = atom<boolean>(false);

export const freeDragEnabledAtom = atomWithStorage<boolean>(
  "free-drag-enabled",
  false
);

export type MoveType = "click" | "drag";

export const moveTypeAtom = atomWithStorage<MoveType>(
  "move-type",
  typeof window !== "undefined" && window.innerWidth <= 768 ? "click" : "drag"
);

export const toastAutoCloseEnabledAtom = atomWithStorage<boolean>(
  "toast-autoclose-enabled",
  true
);

export const soundEnabledAtom = atomWithStorage("sound-enabled", true);

export const autoRotateSeatAtom = atomWithStorage<boolean>(
  "auto-rotate-seat",
  true
);

export const themeSettingAtom = atomWithStorage<ThemeSetting>(
  "theme-setting",
  "system"
);

// For test mode click-to-move functionality
export interface SelectedCardState {
  fromPileId: string;
  cardId: number;
}

export const selectedCardAtom = atom<SelectedCardState | null>(null);
