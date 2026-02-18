import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { FullScreenMessage } from "./components/FullScreenMessage";
import { TestHUD } from "./components/TestHUD";
import { selectedCardAtom } from "./state";
import {
  activeGamesAtom,
  allSeatsJoinedAtom,
  allSeatsAutomatedAtom,
  availableGamesAtom,
  gameIdAtom,
  gameViewAtom,
  isEvaluatingMoveAtom,
  playerIdAtom,
  ruleEngineModeAtom,
  seatStatusAtom,
  roomSeedAtom,
  statusMessageAtom,
  isConnectedAtom,
  rulesIdAtom,
  activeTransitionCardIdsAtom,
  pileSortSelectionsAtom,
  cardSetAtom,
  pendingDragMoveAtom,
  fatalErrorAtom,
  aiLogAtom,
  aiHistoricalUnavailableAtom,
  gameLogAtom,
  isMenuOpenAtom,
  isActionsOpenAtom,
  isScoreboardOpenAtom,
  toastAutoCloseEnabledAtom,
  aiRuntimePreferenceAtom,
  frontendAiSponsorsAtom,
  serverAiEnabledAtom,
  aiShowExceptionsAtom,
  backendRuntimeAtom,
  localAiConfigAtom,
  themeSettingAtom,
  highlightedActionIdAtom,
  highlightedActionLabelAtom,
  highlightedScoreboardCellsAtom,
  recentGamesAtom,
  type StatusMessage,
  type AvailableGame,
  type RecentGameEntry,
  type PendingDragMove,
} from "./state";
import {
  CARD_SETS,
  DEFAULT_CARD_SET,
  DEFAULT_MOBILE_CARD_SET,
} from "./cardSets";
import { sfx } from "./utils/audio";
import { useGameMeta } from "./hooks/useGameMeta";
import {
  fetchActiveGames,
  getServerUrlOverride,
  SERVER_URL,
  setServerUrlOverride,
  clearServerUrlOverride,
  isIdentityEnabledOnClient,
  joinGame,
  watchGame,
  leaveGame,
  releaseSeat,
  restartGame,
  startGame,
  sendActionIntent,
  setSeatAsAi,
  setSeatFrontendAi,
} from "./socket";
import { shareGameInfo } from "./utils/share";
import type {
  CardView,
  GameView,
  ViewEventPayload,
  LayoutZone,
  AnnounceAnchor,
} from "../../shared/schemas";
import { RulesOverlay } from "./components/RulesOverlay";
import { AboutOverlay } from "./components/AboutOverlay";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { type FloatingActionItem } from "./components/FloatingActionOverlay";
import { useAiLog } from "./hooks/useAiLog";
import { useGameLayout } from "./hooks/useGameLayout";
import { safeStartViewTransition } from "./utils/viewTransition";
import { GameDetailsModal } from "./components/Lobby/GameDetailsModal";
import { LobbyScreen } from "./components/Lobby/LobbyScreen";
import { RoomLobbyOverlay } from "./components/Lobby/RoomLobbyOverlay";
import { GameShell } from "./components/GameShell";
import { useMenuControls } from "./hooks/useMenuControls";
import { useGameTitle } from "./hooks/useGameTitle";
import { useGameSocketHandlers } from "./hooks/useGameSocketHandlers";
import { useLobbyData } from "./hooks/useLobbyData";
import { useConnectionStatus } from "./hooks/useConnectionStatus";
import { useRouteHandlers } from "./hooks/useRouteHandlers";
import { useAutoJoin } from "./hooks/useAutoJoin";
import {
  buildPileTransitionConfig,
  type PileTransitionConfig,
} from "./utils/pileTransitions";
import { parseRouteFromLocation } from "./utils/appRouting";
import { hasGameDealt } from "./utils/gameViewState";
import {
  CARD_SET_STORAGE_KEY,
  DEFAULT_LOBBY_SEED,
  MAX_RECENT_GAMES,
} from "./app/constants";
import {
  getGuestId,
  signInWithEmailMagicLink,
  signOutSupabaseIdentity,
  subscribeClientIdentity,
  type ClientIdentityState,
} from "./auth/supabase-identity";

type IncomingStatePayload = GameView;
type AnnounceViewEvent = Extract<ViewEventPayload, { type: "announce" }>;
type PendingAnnouncement = {
  id: string;
  label: string;
  anchor?: AnnounceAnchor;
  anchorKey: string;
  durationMs: number;
};

const MAX_ANNOUNCEMENT_QUEUE_SIZE = 12;
const ANNOUNCEMENT_BURST_WINDOW_MS = 350;
const ANNOUNCEMENT_CHAIN_GAP_MS = 140;
const DEADLOCK_ASSERT_PREFIX = "[DEADLOCK_ASSERT]";

function getAnnouncementAnchorKey(anchor?: AnnounceAnchor): string {
  if (anchor?.type === "pile") {
    return `pile:${anchor.pileId}`;
  }
  return "screen";
}

function isDeadlockAssertionMessage(message: string): boolean {
  return message.includes(DEADLOCK_ASSERT_PREFIX);
}

export default function App() {
  const store = useStore();
  const view = useAtomValue(gameViewAtom);
  const playerId = useAtomValue(playerIdAtom);
  const gameId = useAtomValue(gameIdAtom);
  const seats = useAtomValue(seatStatusAtom);
  const roomSeed = useAtomValue(roomSeedAtom);
  const isConnected = useAtomValue(isConnectedAtom);
  const allSeatsJoined = useAtomValue(allSeatsJoinedAtom);
  const [availableGames, setAvailableGames] = useAtom(availableGamesAtom);
  const availableGamesAtomValue = useAtomValue(availableGamesAtom);
  const [activeGames, setActiveGames] = useAtom(activeGamesAtom);
  const [recentGames, setRecentGames] = useAtom(recentGamesAtom);
  const [cardSet, setCardSet] = useAtom(cardSetAtom);
  const [aiRuntimePreference, setAiRuntimePreference] = useAtom(
    aiRuntimePreferenceAtom
  );
  const [localAiConfig, setLocalAiConfig] = useAtom(localAiConfigAtom);
  const [frontendAiSponsors, setFrontendAiSponsors] = useAtom(
    frontendAiSponsorsAtom
  );
  const setServerAiEnabled = useSetAtom(serverAiEnabledAtom);
  const setAiShowExceptions = useSetAtom(aiShowExceptionsAtom);
  const setBackendRuntime = useSetAtom(backendRuntimeAtom);
  const serverAiEnabled = useAtomValue(serverAiEnabledAtom);
  const backendRuntime = useAtomValue(backendRuntimeAtom);
  const lastAuthoritativeViewRef = useRef<GameView | null>(null);
  const lastStartActionIdRef = useRef<string | null>(null);
  const stateQueueRef = useRef<IncomingStatePayload[]>([]);
  const isProcessingRef = useRef(false);
  const stateGenerationRef = useRef(0);

  const setView = useSetAtom(gameViewAtom);
  const setPlayerId = useSetAtom(playerIdAtom);
  const setSeats = useSetAtom(seatStatusAtom);
  const setRoomSeed = useSetAtom(roomSeedAtom);
  const setIsEvaluating = useSetAtom(isEvaluatingMoveAtom);
  const setGameId = useSetAtom(gameIdAtom);
  const rulesId = useAtomValue(rulesIdAtom);
  const setGameType = useSetAtom(rulesIdAtom);
  const setRuleEngineMode = useSetAtom(ruleEngineModeAtom);
  const setIsConnected = useSetAtom(isConnectedAtom);
  const setActiveTransitionCardIds = useSetAtom(activeTransitionCardIdsAtom);
  const setPendingDragMove = useSetAtom(pendingDragMoveAtom);
  const [fatalError, setFatalError] = useAtom(fatalErrorAtom);
  const setAiLog = useSetAtom(aiLogAtom);
  const setAiHistoricalUnavailable = useSetAtom(aiHistoricalUnavailableAtom);
  const setGameLog = useSetAtom(gameLogAtom);
  const [startingGameType, setStartingGameType] = useState<string | null>(null);
  const [isCreator, setIsCreator] = useState(false);
  const [joinedGameId, setJoinedGameId] = useState<string | null>(null);
  const [joinAsGodMode, setJoinAsGodMode] = useState(false);
  const [isInitialGameLoad, setIsInitialGameLoad] = useState(true);
  const [boundaryEscalationError, setBoundaryEscalationError] =
    useState<Error | null>(null);

  const [themeSetting, setThemeSetting] = useAtom(themeSettingAtom);
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const [autoStartPending, setAutoStartPending] = useState(false);
  const [isStartGamePending, setIsStartGamePending] = useState(false);
  const [isStartGameAnimating, setIsStartGameAnimating] = useState(false);
  const [startGamePendingKind, setStartGamePendingKind] = useState<
    "first" | "next" | null
  >(null);
  const [highlightedWidget, setHighlightedWidget] = useState<
    "actions" | "scoreboards" | null
  >(null);
  const [isActionsAttentionPulse, setIsActionsAttentionPulse] = useState(false);
  const [isEndOverlayMinimized, setIsEndOverlayMinimized] = useState(false);
  const [headerTransitionCards, setHeaderTransitionCards] = useState<
    CardView[]
  >([]);
  const [announcementItems, setAnnouncementItems] = useState<
    FloatingActionItem[]
  >([]);
  const pendingDragMove = useAtomValue(pendingDragMoveAtom);
  const pendingDragMoveRef = useRef<PendingDragMove | null>(null);
  const startGameActionIdRef = useRef<string | null>(null);
  const startGamePendingTimeoutRef = useRef<number | null>(null);
  const skipAnimationsRef = useRef(false);
  const skipAnimationWaitersRef = useRef<Set<() => void>>(new Set());
  const activeViewTransitionRef = useRef<{
    skipTransition?: () => void;
  } | null>(null);
  const restoredFrontendAiRef = useRef<Set<string>>(new Set());
  const isAnyOverlayOpenRef = useRef(false);
  const announcementQueueRef = useRef<PendingAnnouncement[]>([]);
  const activeAnnouncementIdRef = useRef<string | null>(null);
  const activeAnnouncementAnchorKeyRef = useRef<string | null>(null);
  const announcementNextTimerRef = useRef<number | null>(null);
  const lastAnnouncementQueuedAtRef = useRef(0);
  const announcementBurstCountRef = useRef(0);
  const announcementGameIdRef = useRef("");
  const actionOnlyAttentionHandledRef = useRef(false);

  useEffect(() => {
    pendingDragMoveRef.current = pendingDragMove;
  }, [pendingDragMove]);

  useEffect(() => {
    if (!fatalError) return;
    if (boundaryEscalationError) return;
    if (!isDeadlockAssertionMessage(fatalError.message)) return;

    setFatalError(null);
    setBoundaryEscalationError(
      new Error(`Runtime deadlock assertion failed.\n${fatalError.message}`)
    );
  }, [boundaryEscalationError, fatalError, setFatalError]);

  if (boundaryEscalationError) {
    throw boundaryEscalationError;
  }

  const clearSkipStartGameAnimations = useCallback(() => {
    skipAnimationsRef.current = false;
    skipAnimationWaitersRef.current.clear();
    activeViewTransitionRef.current = null;
  }, []);

  const requestSkipStartGameAnimations = useCallback(() => {
    skipAnimationsRef.current = true;
    if (typeof document !== "undefined") {
      document.documentElement.style.setProperty(
        "--transition-duration",
        "0ms"
      );
    }
    if (stateQueueRef.current.length > 1) {
      stateQueueRef.current = [
        stateQueueRef.current[stateQueueRef.current.length - 1],
      ];
    }
    for (const cancel of skipAnimationWaitersRef.current) {
      cancel();
    }
    skipAnimationWaitersRef.current.clear();
    activeViewTransitionRef.current?.skipTransition?.();
  }, []);

  const waitMsOrSkip = useCallback((durationMs: number): Promise<void> => {
    if (durationMs <= 0 || skipAnimationsRef.current) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let timeoutId = 0;
      const cancel = () => {
        window.clearTimeout(timeoutId);
        skipAnimationWaitersRef.current.delete(cancel);
        resolve();
      };
      timeoutId = window.setTimeout(() => {
        skipAnimationWaitersRef.current.delete(cancel);
        resolve();
      }, durationMs);
      skipAnimationWaitersRef.current.add(cancel);
    });
  }, []);

  const clearStartGamePending = useCallback(
    (options?: { keepKind?: boolean }) => {
      if (startGamePendingTimeoutRef.current) {
        window.clearTimeout(startGamePendingTimeoutRef.current);
        startGamePendingTimeoutRef.current = null;
      }
      setIsStartGamePending(false);
      if (!options?.keepKind) {
        setStartGamePendingKind(null);
      }
    },
    []
  );

  const markStartGamePending = useCallback(() => {
    setIsStartGamePending(true);
    if (startGamePendingTimeoutRef.current) {
      window.clearTimeout(startGamePendingTimeoutRef.current);
    }
    startGamePendingTimeoutRef.current = window.setTimeout(() => {
      setIsStartGamePending(false);
      startGamePendingTimeoutRef.current = null;
    }, 10000);
  }, []);

  useEffect(() => {
    return () => {
      clearStartGamePending();
    };
  }, [clearStartGamePending]);

  useEffect(() => {
    if (!gameId) {
      clearStartGamePending();
      clearSkipStartGameAnimations();
      setIsStartGameAnimating(false);
      startGameActionIdRef.current = null;
      setStartGamePendingKind(null);
      setAiHistoricalUnavailable(false);
    }
  }, [
    clearSkipStartGameAnimations,
    clearStartGamePending,
    gameId,
    setAiHistoricalUnavailable,
  ]);

  const activeRulesId = view?.rulesId ?? rulesId;
  const gameLayout = useGameLayout(activeRulesId ?? "");
  const gameLayoutRef = useRef(gameLayout);
  useEffect(() => {
    gameLayoutRef.current = gameLayout;
  }, [gameLayout]);
  const lastAction = view?.lastAction;
  const pileTransitionConfigRef = useRef<PileTransitionConfig>(
    buildPileTransitionConfig(gameLayout)
  );

  useEffect(() => {
    if (!lastAction || lastAction.action !== "start-game") return;
    if (lastStartActionIdRef.current === lastAction.id) return;
    lastStartActionIdRef.current = lastAction.id;

    // Only clear if it's really the first start (no hand dealt yet)
    // We can check if rulesState says dealNumber is 0 or missing
    const rs = view?.rulesState as { dealNumber?: number } | null;
    const isFirstStart = !rs || !rs.dealNumber || rs.dealNumber <= 1;

    if (isFirstStart) {
      setAiLog([]);
      setGameLog([]);
    }
  }, [lastAction, setAiLog, setGameLog, view?.rulesState]);

  // Helper to check if a widget exists in the current layout
  const hasWidgetInLayout = useCallback(
    (widgetType: "actions" | "scoreboards") => {
      return (
        gameLayout?.zones.some((z: LayoutZone) => z.widget === widgetType) ??
        false
      );
    },
    [gameLayout]
  );

  const visiblePileIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    visiblePileIdsRef.current = new Set(
      gameLayout?.zones.flatMap((zone) => zone.piles) ?? []
    );
  }, [gameLayout]);

  useEffect(() => {
    pileTransitionConfigRef.current = buildPileTransitionConfig(gameLayout);
  }, [gameLayout]);

  // Settings UI State
  const [showSettings, setShowSettings] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useAtom(isMenuOpenAtom);
  const [isRulesVisible, setRulesVisible] = useState(false);
  const [isAboutVisible, setAboutVisible] = useState(false);
  const [isAboutFromMenu, setIsAboutFromMenu] = useState(false);
  const [isActionsOpen, setIsActionsOpen] = useAtom(isActionsOpenAtom);
  const [isScoreboardOpen, setIsScoreboardOpen] = useAtom(isScoreboardOpenAtom);
  const [toastAutoCloseEnabled, setToastAutoCloseEnabled] = useAtom(
    toastAutoCloseEnabledAtom
  );
  const allSeatsAutomated = useAtomValue(allSeatsAutomatedAtom);
  const { openAiLog, isAiLogVisible } = useAiLog();
  const effectiveAiPreference =
    aiRuntimePreference === "backend" && !serverAiEnabled
      ? "off"
      : aiRuntimePreference;

  // Auto-disable toast auto-close for AI-only games
  const lastAiGameHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      gameId &&
      allSeatsAutomated &&
      lastAiGameHandledRef.current !== gameId
    ) {
      setToastAutoCloseEnabled(false);
      lastAiGameHandledRef.current = gameId;
    }
    if (!gameId) {
      lastAiGameHandledRef.current = null;
    }
  }, [gameId, allSeatsAutomated, setToastAutoCloseEnabled]);
  const { closeAll } = useMenuControls();

  const gameTitle = useGameTitle(activeRulesId);
  const hasScoreboardsInLayout = hasWidgetInLayout("scoreboards");

  // Detect if we are in a "next round" or "game winner" state to pop out the scoreboard
  const isWinnerOverlayVisible = !!view?.winner;
  const isNextRound = useMemo(() => {
    const rulesState =
      view?.rulesState && typeof view.rulesState === "object"
        ? (view.rulesState as Record<string, unknown>)
        : null;
    if (!rulesState) return false;

    const isNumber = (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value);

    const hasNonZeroNumbers = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      return Object.values(value as Record<string, unknown>).some(
        (entry) => isNumber(entry) && entry !== 0
      );
    };

    return (
      (isNumber(rulesState.dealNumber) && rulesState.dealNumber > 0) ||
      (isNumber(rulesState.roundNumber) && rulesState.roundNumber > 1) ||
      (isNumber(rulesState.handNumber) && rulesState.handNumber > 1) ||
      hasNonZeroNumbers(rulesState.scores) ||
      hasNonZeroNumbers(rulesState.gameScore) ||
      hasNonZeroNumbers(rulesState.lastHandScore)
    );
  }, [view?.rulesState]);

  const startGameBusy = isStartGamePending || isStartGameAnimating;
  const holdStartOverlay = isStartGameAnimating;
  const startOverlayIsNextRoundOverride = startGameBusy
    ? startGamePendingKind === "next"
      ? true
      : startGamePendingKind === "first"
        ? false
        : null
    : null;

  const isNextRoundOverlayVisible =
    !!view?.gameId &&
    !!playerId &&
    allSeatsJoined &&
    (!hasGameDealt(view) || holdStartOverlay) &&
    isNextRound &&
    !view?.winner;

  const suppressStartOverlay = false;
  const isAnyEndOverlayVisible =
    isWinnerOverlayVisible || isNextRoundOverlayVisible;
  // Track when pure UI overlays are open to skip View Transitions entirely.
  // Start/dealing and winner overlays are tracked separately so we can use
  // manual card animations while keeping dialogs interactive.
  const isAnyModalOverlayOpen =
    isMenuOpen || isRulesVisible || isAboutVisible || isAiLogVisible;

  useEffect(() => {
    isAnyOverlayOpenRef.current = isAnyModalOverlayOpen;
  }, [isAnyModalOverlayOpen]);

  useEffect(() => {
    if (!isAnyEndOverlayVisible) {
      setIsEndOverlayMinimized(false);
    }
  }, [isAnyEndOverlayVisible]);

  useEffect(() => {
    if (lastAction?.action === "start-game") {
      setIsScoreboardOpen(false);
    }
  }, [lastAction, setIsScoreboardOpen]);

  // Auto-open scoreboard when a round/game ends.
  useEffect(() => {
    if (!isAnyEndOverlayVisible || isEndOverlayMinimized) {
      setIsScoreboardOpen(false);
      return;
    }
    if (hasScoreboardsInLayout) {
      setIsScoreboardOpen(false);
      setHighlightedWidget("scoreboards");
      const timer = window.setTimeout(() => setHighlightedWidget(null), 1200);
      return () => {
        window.clearTimeout(timer);
      };
    }
    setIsScoreboardOpen(true);
  }, [
    hasScoreboardsInLayout,
    isEndOverlayMinimized,
    isAnyEndOverlayVisible,
    setIsScoreboardOpen,
    setHighlightedWidget,
  ]);

  useEffect(() => {
    setIsScoreboardOpen(false);
  }, [gameId, setIsScoreboardOpen]);

  useEffect(() => {
    if (hasScoreboardsInLayout) {
      setIsScoreboardOpen(false);
    }
  }, [hasScoreboardsInLayout, setIsScoreboardOpen]);

  // Update document title based on current game state
  useEffect(() => {
    if (gameTitle && gameId) {
      document.title = `AnyCard - ${gameTitle}`;
    } else {
      document.title = "AnyCard";
    }
  }, [gameTitle, gameId]);

  // Close open widgets on orientation / viewport change.
  // We track the last known dimensions so that spurious resize events
  // (e.g. layout reflows from card animations) don't close the menu.
  useEffect(() => {
    let lastW = window.innerWidth;
    let lastH = window.innerHeight;
    const handleResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (w !== lastW || h !== lastH) {
        lastW = w;
        lastH = h;
        closeAll();
      }
    };
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
    };
  }, [closeAll]);

  // Auto-open actions widget when game starts and actions become available
  const hasActions = (view?.actions?.cells?.length ?? 0) > 0;
  const legalIntents = view?.legalIntents ?? [];
  const legalActionIntentCount = legalIntents.filter(
    (intent) => intent.type === "action"
  ).length;
  const legalMoveIntentCount = legalIntents.filter(
    (intent) => intent.type === "move"
  ).length;
  const shouldDrawActionsAttention =
    hasGameDealt(view) &&
    hasActions &&
    legalActionIntentCount > 0 &&
    legalMoveIntentCount === 0;
  const lastHasDealtRef = useRef(false);
  const [hasSeenNotDealt, setHasSeenNotDealt] = useState(false);

  useEffect(() => {
    actionOnlyAttentionHandledRef.current = false;
    setIsActionsAttentionPulse(false);
  }, [gameId]);

  useEffect(() => {
    if (view && !hasGameDealt(view)) {
      setHasSeenNotDealt(true);
    }
  }, [view]);

  useEffect(() => {
    // Wait for layout to be loaded before making auto-open decisions
    if (!gameLayout) return;

    const currentHasDealt = hasGameDealt(view);

    // If game just transitioned from not-dealt to dealt WHILE we were watching
    if (currentHasDealt && !lastHasDealtRef.current && hasSeenNotDealt) {
      // ONLY auto-open if the game has actions AND they aren't already visible on the table layout
      if (hasActions && !hasWidgetInLayout("actions")) {
        // Delay slightly to allow start animation to begin
        setTimeout(() => setIsActionsOpen(true), 1500);
      }
    }

    lastHasDealtRef.current = currentHasDealt;
  }, [
    view,
    hasActions,
    setIsActionsOpen,
    hasWidgetInLayout,
    gameLayout,
    hasSeenNotDealt,
  ]);

  useEffect(() => {
    if (!shouldDrawActionsAttention) {
      actionOnlyAttentionHandledRef.current = false;
      setIsActionsAttentionPulse(false);
      return;
    }

    if (actionOnlyAttentionHandledRef.current) {
      return;
    }
    actionOnlyAttentionHandledRef.current = true;

    if (hasWidgetInLayout("actions")) {
      setIsActionsAttentionPulse(false);
      setHighlightedWidget("actions");
      const highlightTimer = window.setTimeout(
        () => setHighlightedWidget(null),
        1200
      );
      return () => {
        window.clearTimeout(highlightTimer);
      };
    }

    setIsActionsAttentionPulse(true);
    const pulseTimer = window.setTimeout(
      () => setIsActionsAttentionPulse(false),
      1500
    );
    const openTimer = window.setTimeout(() => {
      setIsActionsOpen((prev) => (prev ? prev : true));
    }, 1000);

    return () => {
      window.clearTimeout(pulseTimer);
      window.clearTimeout(openTimer);
      setIsActionsAttentionPulse(false);
    };
  }, [
    hasWidgetInLayout,
    setHighlightedWidget,
    setIsActionsOpen,
    shouldDrawActionsAttention,
  ]);

  const sortedAvailableGames = [...availableGames].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );

  const initialRoute = parseRouteFromLocation();

  const defaultRouteRef = useRef<string | null>(
    initialRoute?.kind === "default" ? initialRoute.rulesId : null
  );
  const lastJoinRef = useRef<{
    gameId: string;
    rulesId: string;
    playerId: string;
    role: "player" | "spectator";
    isGodMode?: boolean;
    roomType?: "demo" | "public" | "private";
  } | null>(null);

  useEffect(() => {
    setRecentGames((prev) =>
      prev.map((entry) => {
        if (entry.roomType) {
          return entry;
        }
        const legacyRoomType = (
          entry as unknown as { isDedicatedLobby?: boolean }
        ).isDedicatedLobby
          ? "demo"
          : "private";
        return { ...entry, roomType: legacyRoomType };
      })
    );
  }, [setRecentGames]);

  const upsertRecentGame = useCallback(
    (entry: RecentGameEntry) => {
      setRecentGames((prev) => {
        const next = [
          entry,
          ...prev.filter((game) => game.gameId !== entry.gameId),
        ];
        return next.slice(0, MAX_RECENT_GAMES);
      });
    },
    [setRecentGames]
  );

  const removeRecentGame = useCallback(
    (gameId: string) => {
      setRecentGames((prev) => prev.filter((game) => game.gameId !== gameId));
    },
    [setRecentGames]
  );

  type RouteError =
    | null
    | { kind: "GAME_NOT_FOUND"; gameId?: string; rulesId?: string }
    | {
        kind: "UNKNOWN_ERROR";
        gameId?: string;
        rulesId?: string;
        message?: string;
      };

  const [routeError, setRouteError] = useState<RouteError>(null);
  const [identityState, setIdentityState] = useState<ClientIdentityState>({
    mode: "guest",
    guestId: getGuestId(),
    userId: null,
    email: null,
  });
  const [authEmailInput, setAuthEmailInput] = useState("");
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const isCurrentPlayerSeated =
    !!playerId &&
    seats.some((seat) => seat.playerId === playerId && seat.occupied);

  useEffect(() => {
    const unsubscribe = subscribeClientIdentity((identity) => {
      setIdentityState(identity);
      if (identity.mode === "user") {
        setAuthMessage(null);
      }
    });
    return unsubscribe;
  }, []);

  // Determine if the game has started based on whether cards have been dealt
  const hasGameStarted = hasGameDealt(view);

  const gameMeta = useGameMeta(view?.rulesId);
  const allowedCardSets = (() => {
    if (gameMeta?.requiresJokers) {
      return CARD_SETS.filter((set) => set.supportsJokers);
    }
    return CARD_SETS;
  })();

  const ensureDefaultGameForType = useCallback(
    async (rulesId: string) => {
      defaultRouteRef.current = rulesId;
      setRouteError(null);
      setGameType(rulesId);
      setGameId("");
      setStartingGameType(rulesId);
      // Ask backend to reuse a dedicated lobby game for this type if it exists
      const resetDedicated =
        new URLSearchParams(window.location.search).get("reset") === "1";
      startGame(rulesId, DEFAULT_LOBBY_SEED, {
        dedicatedLobby: true,
        resetDedicated,
      });
    },
    [setGameId, setGameType, setRouteError, setStartingGameType]
  );

  // Ref to track gameId without triggering effect re-runs
  const gameIdRef = useRef(gameId);
  useEffect(() => {
    gameIdRef.current = gameId;
  }, [gameId]);

  const rememberAndJoin = useCallback(
    (
      targetGameId: string,
      targetRulesId: string,
      targetPlayerId: string,
      role: "player" | "spectator",
      opts?: { isGodMode?: boolean },
      meta?: { roomType?: "demo" | "public" | "private" }
    ) => {
      const roomType =
        meta?.roomType ??
        activeGames.find((game) => game.gameId === targetGameId)?.roomType ??
        "private";

      lastJoinRef.current = {
        gameId: targetGameId,
        rulesId: targetRulesId,
        playerId: targetPlayerId,
        role,
        isGodMode: opts?.isGodMode,
        roomType,
      };

      if (targetRulesId) {
        upsertRecentGame({
          gameId: targetGameId,
          rulesId: targetRulesId,
          roomType,
          lastRole: role,
          lastPlayerId: targetPlayerId,
          lastJoinedAt: Date.now(),
        });
      }

      setJoinedGameId(targetGameId);
      joinGame(targetGameId, targetPlayerId, role, opts);
    },
    [activeGames, setJoinedGameId, upsertRecentGame]
  );

  const attemptRejoin = useCallback(() => {
    const activeGameId = gameIdRef.current;
    if (!activeGameId) return;
    const lastJoin = lastJoinRef.current;
    if (!lastJoin) {
      watchGame(activeGameId);
      return;
    }
    if (activeGameId !== lastJoin.gameId) return;
    rememberAndJoin(
      lastJoin.gameId,
      lastJoin.rulesId,
      lastJoin.playerId,
      lastJoin.role,
      {
        isGodMode: lastJoin.isGodMode,
      },
      { roomType: lastJoin.roomType }
    );
  }, [rememberAndJoin]);

  // Reset state when game changes
  useEffect(() => {
    setIsInitialGameLoad(true);
  }, [gameId]);

  // When we get any view, it's no longer the "initial load"
  useEffect(() => {
    if (view) {
      setIsInitialGameLoad(false);
    }
  }, [view]);

  // Cancel auto-deal tracking if we leave or switch games
  useEffect(() => {
    if (!gameId) {
      setAutoStartPending(false);
    }
  }, [gameId]);

  const autoStartSawUndealtRef = useRef(false);

  // Clear auto-start suppression once we observed an undealt state and then a dealt state again
  useEffect(() => {
    if (!autoStartPending) {
      autoStartSawUndealtRef.current = false;
      return;
    }

    const hasDealt = hasGameDealt(view);
    if (!hasDealt) {
      autoStartSawUndealtRef.current = true;
      return;
    }

    if (autoStartSawUndealtRef.current) {
      setAutoStartPending(false);
      autoStartSawUndealtRef.current = false;
    }
  }, [view, autoStartPending]);

  useAutoJoin({
    gameId,
    routeError,
    joinedGameId,
    recentGames,
    rulesId,
    view,
    playerId,
    setPlayerId,
    setJoinedGameId,
    rememberAndJoin,
  });

  const handleGameNotFoundOnReconnect = useCallback(() => {
    // Only handle this once; if routeError already set, ignore
    if (routeError?.kind === "GAME_NOT_FOUND") return;

    const badGameId = gameIdRef.current;
    const badGameType = rulesId;

    if (badGameId) {
      removeRecentGame(badGameId);
    }

    // Clear local game state
    setGameId("");
    setGameType(null);
    setSeats([]);
    setRoomSeed(null);
    setView(null);
    setJoinedGameId(null);
    lastJoinRef.current = null;

    // Mark route as invalid so auto-join stops
    setRouteError({
      kind: "GAME_NOT_FOUND",
      gameId: badGameId,
      rulesId: badGameType ?? undefined,
    });

    // Navigate to root *once*; use replaceState to avoid growing history
    try {
      window.history.replaceState({}, "", "/");
    } catch (err) {
      // Some Safari builds can be picky here; ignore failures
      console.warn("Failed to replaceState after Game not found", err);
    }
  }, [
    routeError,
    rulesId,
    removeRecentGame,
    setGameId,
    setGameType,
    setSeats,
    setRoomSeed,
    setView,
    setJoinedGameId,
    setRouteError,
  ]);

  useConnectionStatus({
    isConnected,
    setIsConnected,
    attemptRejoin,
    gameId,
    onGameNotFound: handleGameNotFoundOnReconnect,
  });

  useRouteHandlers({
    initialRoute,
    availableGames: availableGamesAtomValue,
    defaultRouteRef,
    gameIdRef,
    lastJoinRef,
    setGameId,
    setGameType,
    setRouteError,
    setJoinedGameId,
    setSeats,
    setRoomSeed,
    setView,
    setPlayerId,
    setActiveGames,
    ensureDefaultGameForType,
  });

  const isLobbyView = !gameId && !routeError;
  const {
    isLobbyLoading,
    lobbyLoadError,
    identityWarning,
    serverIdentityEnabled,
    refreshLobby,
  } = useLobbyData({
    aiRuntimePreference,
    setAiRuntimePreference,
    setAvailableGames,
    setActiveGames,
    setRuleEngineMode,
    setServerAiEnabled,
    setAiShowExceptions,
    setBackendRuntime,
    isLobbyView,
  });

  useEffect(() => {
    if (activeGames.length === 0) return;
    setRecentGames((prev) =>
      prev.map((entry) =>
        activeGames.some((game) => game.gameId === entry.gameId)
          ? {
              ...entry,
              roomType:
                activeGames.find((game) => game.gameId === entry.gameId)
                  ?.roomType ?? entry.roomType,
            }
          : entry
      )
    );
  }, [activeGames, setRecentGames]);

  const [activeToasts, setActiveToasts] = useAtom(statusMessageAtom);
  const setHighlightedActionId = useSetAtom(highlightedActionIdAtom);
  const setHighlightedActionLabel = useSetAtom(highlightedActionLabelAtom);
  const setHighlightedScoreboardCells = useSetAtom(
    highlightedScoreboardCellsAtom
  );
  const previousUiGameIdRef = useRef(gameId);

  useEffect(() => {
    if (previousUiGameIdRef.current !== gameId) {
      // Prevent transient overlay/highlight state from leaking between games.
      closeAll();
      setRulesVisible(false);
      setAboutVisible(false);
      setIsAboutFromMenu(false);
      setHighlightedWidget(null);
      setHighlightedActionId(null);
      setHighlightedActionLabel(null);
      setHighlightedScoreboardCells({});
    }
    previousUiGameIdRef.current = gameId;
  }, [
    closeAll,
    gameId,
    setHighlightedActionId,
    setHighlightedActionLabel,
    setHighlightedScoreboardCells,
  ]);

  const lastToastIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (activeToasts.length > 0) {
      const latest = activeToasts[0];
      if (latest.id !== lastToastIdRef.current) {
        lastToastIdRef.current = latest.id;
        if (latest.tone === "error") {
          sfx.playError();
        }
      }
    }
  }, [activeToasts]);

  const removeToast = useCallback(
    (id: number) => {
      setActiveToasts((prev) => prev.filter((t) => t.id !== id));
    },
    [setActiveToasts]
  );

  const [selectedGameForDetails, setSelectedGameForDetails] =
    useState<AvailableGame | null>(null);
  const [serverUrlInput, setServerUrlInput] = useState(
    () => getServerUrlOverride() ?? SERVER_URL
  );
  const [serverUrlInputError, setServerUrlInputError] = useState<string | null>(
    null
  );
  const [hasServerUrlOverride, setHasServerUrlOverride] = useState(() =>
    Boolean(getServerUrlOverride())
  );
  const [isServerSettingsExpanded, setIsServerSettingsExpanded] =
    useState(false);

  const applyServerUrlOverride = useCallback(() => {
    const normalized = setServerUrlOverride(serverUrlInput);
    if (!normalized) {
      setServerUrlInputError("Enter a valid server URL or IP.");
      return;
    }
    window.location.reload();
  }, [serverUrlInput]);

  const resetServerUrlOverride = useCallback(() => {
    clearServerUrlOverride();
    setHasServerUrlOverride(false);
    setServerUrlInput(SERVER_URL);
    setServerUrlInputError(null);
    window.location.reload();
  }, []);

  // When clicking a game in the list
  const handleGameSelect = (game: AvailableGame) => {
    setSelectedGameForDetails(game);
  };

  const lobbyStatus = serverUrlInputError
    ? {
        tone: "error" as const,
        label: "Input error",
        message: serverUrlInputError,
      }
    : lobbyLoadError
      ? {
          tone: "error" as const,
          label: "Connection error",
          message: lobbyLoadError,
        }
      : identityWarning
        ? {
            tone: "warning" as const,
            label: "Identity warning",
            message: identityWarning,
          }
        : isLobbyLoading
          ? {
              tone: "loading" as const,
              label: "Loading",
              message: "Connecting to server and loading games.",
            }
          : {
              tone: "idle" as const,
              label: "Idle",
              message: "Waiting for lobby updates.",
            };

  const showStatus = useCallback(
    (message: Omit<StatusMessage, "id">) => {
      // Use random offset to ensure uniqueness even if events fire rapidly
      const id = Date.now() + Math.random();
      const newToast = { ...message, id };

      // Prepend (newest first) so it appears at the visual top of the stack
      setActiveToasts((prev) => [newToast, ...prev]);

      if (toastAutoCloseEnabled) {
        setTimeout(() => {
          removeToast(id);
        }, 3750);
      }
    },
    [setActiveToasts, removeToast, toastAutoCloseEnabled]
  );

  const handleSendMagicLink = useCallback(async () => {
    if (!serverIdentityEnabled || !isIdentityEnabledOnClient()) {
      setAuthMessage(
        "Supabase sign-in is not available on this server. Continue as guest."
      );
      return;
    }

    const normalized = authEmailInput.trim().toLowerCase();
    if (!normalized) {
      setAuthMessage("Enter an email address first.");
      return;
    }

    setAuthBusy(true);
    setAuthMessage(null);
    try {
      await signInWithEmailMagicLink(normalized);
      setAuthMessage(`Magic link sent to ${normalized}.`);
      showStatus({
        tone: "success",
        message: `Magic link sent to ${normalized}`,
        source: "app",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to send magic link";
      setAuthMessage(message);
      showStatus({
        tone: "error",
        message,
        source: "app",
      });
    } finally {
      setAuthBusy(false);
    }
  }, [authEmailInput, serverIdentityEnabled, showStatus]);

  const handleSignOutIdentity = useCallback(async () => {
    setAuthBusy(true);
    setAuthMessage(null);
    try {
      await signOutSupabaseIdentity();
      setAuthMessage("Signed out. You are now playing as guest.");
      showStatus({
        tone: "neutral",
        message: "Signed out",
        source: "app",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Sign out failed";
      setAuthMessage(message);
      showStatus({
        tone: "error",
        message,
        source: "app",
      });
    } finally {
      setAuthBusy(false);
    }
  }, [showStatus]);

  const clearAnnouncementPipeline = useCallback(() => {
    if (announcementNextTimerRef.current) {
      window.clearTimeout(announcementNextTimerRef.current);
      announcementNextTimerRef.current = null;
    }
    announcementQueueRef.current = [];
    activeAnnouncementIdRef.current = null;
    activeAnnouncementAnchorKeyRef.current = null;
    lastAnnouncementQueuedAtRef.current = 0;
    announcementBurstCountRef.current = 0;
    setAnnouncementItems([]);
  }, []);

  const resolveAnnouncementPosition = useCallback((anchor?: AnnounceAnchor) => {
    if (anchor?.type === "pile") {
      const selector = `[data-testid="pile:${anchor.pileId}"]`;
      const target = document.querySelector(selector);
      if (target instanceof HTMLElement) {
        const rect = target.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      }
    }

    return {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    };
  }, []);

  const resolveAnnouncementDurationMs = useCallback(
    (text: string, isBurst: boolean) => {
      const normalizedLength = text.length;
      if (isBurst) {
        return Math.max(
          2800,
          Math.min(5600, Math.round(2800 + normalizedLength * 16))
        );
      }
      return Math.max(
        1300,
        Math.min(3200, Math.round(1200 + normalizedLength * 9))
      );
    },
    []
  );

  const showNextAnnouncement = useCallback(() => {
    if (activeAnnouncementIdRef.current) return;
    const next = announcementQueueRef.current.shift();
    if (!next) return;
    const { x, y } = resolveAnnouncementPosition(next.anchor);
    activeAnnouncementIdRef.current = next.id;
    activeAnnouncementAnchorKeyRef.current = next.anchorKey;
    setAnnouncementItems([
      {
        id: next.id,
        label: next.label,
        x,
        y,
        durationMs: next.durationMs,
      },
    ]);
  }, [resolveAnnouncementPosition]);

  const queueAnnouncement = useCallback(
    (event: AnnounceViewEvent) => {
      const now = performance.now();
      const elapsed = now - lastAnnouncementQueuedAtRef.current;
      if (elapsed <= ANNOUNCEMENT_BURST_WINDOW_MS) {
        announcementBurstCountRef.current += 1;
      } else {
        announcementBurstCountRef.current = 1;
      }
      lastAnnouncementQueuedAtRef.current = now;

      const normalizedText = event.text.replace(/\s+/g, " ").trim();
      if (!normalizedText) return;

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const pending: PendingAnnouncement = {
        id,
        label: normalizedText,
        anchor: event.anchor,
        anchorKey: getAnnouncementAnchorKey(event.anchor),
        durationMs: resolveAnnouncementDurationMs(
          normalizedText,
          announcementBurstCountRef.current >= 2
        ),
      };

      const queue = announcementQueueRef.current;
      // Generic stale-message handling: same-anchor announcements are transient,
      // so keep only the latest one for that anchor.
      announcementQueueRef.current = queue.filter(
        (item) => item.anchorKey !== pending.anchorKey
      );
      if (activeAnnouncementAnchorKeyRef.current === pending.anchorKey) {
        const { x, y } = resolveAnnouncementPosition(pending.anchor);
        activeAnnouncementIdRef.current = pending.id;
        activeAnnouncementAnchorKeyRef.current = pending.anchorKey;
        setAnnouncementItems([
          {
            id: pending.id,
            label: pending.label,
            x,
            y,
            durationMs: pending.durationMs,
          },
        ]);
        return;
      }

      const nextQueue = announcementQueueRef.current;
      if (nextQueue.length >= MAX_ANNOUNCEMENT_QUEUE_SIZE) {
        nextQueue.shift();
      }
      nextQueue.push(pending);
      window.requestAnimationFrame(() => {
        showNextAnnouncement();
      });
    },
    [
      resolveAnnouncementDurationMs,
      resolveAnnouncementPosition,
      showNextAnnouncement,
    ]
  );

  const handleAnnouncementComplete = useCallback(
    (id: string) => {
      setAnnouncementItems((prev) => prev.filter((item) => item.id !== id));
      if (activeAnnouncementIdRef.current !== id) return;
      activeAnnouncementIdRef.current = null;
      activeAnnouncementAnchorKeyRef.current = null;
      if (announcementNextTimerRef.current) {
        window.clearTimeout(announcementNextTimerRef.current);
      }
      announcementNextTimerRef.current = window.setTimeout(() => {
        announcementNextTimerRef.current = null;
        showNextAnnouncement();
      }, ANNOUNCEMENT_CHAIN_GAP_MS);
    },
    [showNextAnnouncement]
  );

  useEffect(() => {
    const currentGameId = gameId || "";
    if (announcementGameIdRef.current !== currentGameId) {
      announcementGameIdRef.current = currentGameId;
      clearAnnouncementPipeline();
    }
  }, [clearAnnouncementPipeline, gameId]);

  useEffect(() => {
    return () => {
      if (announcementNextTimerRef.current) {
        window.clearTimeout(announcementNextTimerRef.current);
      }
    };
  }, []);

  const clearHighlightsTimerRef = useRef<number | null>(null);
  const getPileSortSelections = useCallback(
    () => store.get(pileSortSelectionsAtom),
    [store]
  );

  useGameSocketHandlers({
    getPileSortSelections,
    stateQueueRef,
    isProcessingRef,
    stateGenerationRef,
    lastAuthoritativeViewRef,
    pendingDragMoveRef,
    skipAnimationsRef,
    skipAnimationWaitersRef,
    activeViewTransitionRef,
    startGameActionIdRef,
    gameLayoutRef,
    pileTransitionConfigRef,
    visiblePileIdsRef,
    clearHighlightsTimerRef,
    isAnyOverlayOpenRef,
    playerId,
    routeError,
    initialRoute,
    gameIdRef,
    defaultRouteRef,
    lastJoinRef,
    setStartingGameType,
    setGameType,
    setGameId,
    setSeats,
    setRoomSeed,
    setIsInitialGameLoad,
    setIsEvaluating,
    setActiveTransitionCardIds,
    setHeaderTransitionCards,
    setPendingDragMove,
    setFatalError,
    setIsStartGameAnimating,
    setStartGamePendingKind,
    setView,
    setAiLog,
    setAiHistoricalUnavailable,
    setGameLog,
    setJoinedGameId,
    setPlayerId,
    setIsCreator,
    setRouteError,
    setHighlightedActionId,
    setHighlightedActionLabel,
    setHighlightedScoreboardCells,
    showStatus,
    queueAnnouncement,
    clearStartGamePending,
    clearSkipStartGameAnimations,
    waitMsOrSkip,
    attemptRejoin,
    removeRecentGame,
  });

  const handleJoin = (selectedPlayerId: string) => {
    if (!gameId) return;
    setPlayerId(selectedPlayerId);
    rememberAndJoin(gameId, activeRulesId ?? "", selectedPlayerId, "player");
  };

  const handleForceReleaseSeat = useCallback(
    (seatId: string) => {
      if (!gameId) return;
      releaseSeat(gameId, seatId, { force: true });
    },
    [gameId]
  );

  const rememberFrontendAiSponsorSeat = useCallback(
    (targetGameId: string, seatId: string) => {
      setFrontendAiSponsors((prev) => {
        const existing = prev[targetGameId] ?? [];
        if (existing.includes(seatId)) return prev;
        return { ...prev, [targetGameId]: [...existing, seatId] };
      });
    },
    [setFrontendAiSponsors]
  );

  const forgetFrontendAiSponsorSeat = useCallback(
    (targetGameId: string, seatId: string) => {
      setFrontendAiSponsors((prev) => {
        const existing = prev[targetGameId];
        if (!existing || !existing.includes(seatId)) return prev;
        const nextSeats = existing.filter((id) => id !== seatId);
        if (nextSeats.length === 0) {
          const next = { ...prev };
          delete next[targetGameId];
          return next;
        }
        return { ...prev, [targetGameId]: nextSeats };
      });
    },
    [setFrontendAiSponsors]
  );

  const clearFrontendAiSponsors = useCallback(
    (targetGameId: string) => {
      setFrontendAiSponsors((prev) => {
        if (!prev[targetGameId]) return prev;
        const next = { ...prev };
        delete next[targetGameId];
        return next;
      });
    },
    [setFrontendAiSponsors]
  );

  const applyAiSettingForSeat = useCallback(
    (seatId: string, enabled: boolean) => {
      if (!gameId) return;

      const seat = view?.seats?.find((s) => s.seatId === seatId);
      const seatRuntime = seat?.aiRuntime ?? "none";
      const isFrontendSeat = seatRuntime === "frontend";
      const disableFrontendSeat = () => {
        setSeatFrontendAi(gameId, seatId, false);
      };

      const turnOff = !enabled || effectiveAiPreference === "off";
      if (turnOff) {
        if (isFrontendSeat) {
          disableFrontendSeat();
          forgetFrontendAiSponsorSeat(gameId, seatId);
          return;
        }
        forgetFrontendAiSponsorSeat(gameId, seatId);
        setSeatAsAi(gameId, seatId, false);
        return;
      }

      if (effectiveAiPreference === "frontend") {
        setLocalAiConfig((prev) => ({ ...prev, enabled: true }));
        setSeatFrontendAi(gameId, seatId, true);
        rememberFrontendAiSponsorSeat(gameId, seatId);
        return;
      }

      // backend preference
      if (isFrontendSeat) {
        disableFrontendSeat();
      }
      forgetFrontendAiSponsorSeat(gameId, seatId);
      setSeatAsAi(gameId, seatId, true);
    },
    [
      effectiveAiPreference,
      forgetFrontendAiSponsorSeat,
      gameId,
      rememberFrontendAiSponsorSeat,
      setLocalAiConfig,
      view,
    ]
  );

  const clearSponsoredFrontendSeats = useCallback(() => {
    if (!gameId || !view?.seats) {
      return;
    }

    for (const seat of view.seats) {
      if (seat.aiRuntime === "frontend" && seat.isAiControlledByYou) {
        setSeatFrontendAi(gameId, seat.seatId, false);
        forgetFrontendAiSponsorSeat(gameId, seat.seatId);
      }
    }
  }, [forgetFrontendAiSponsorSeat, gameId, view]);

  useEffect(() => {
    if (aiRuntimePreference === "frontend") return;
    clearSponsoredFrontendSeats();
    if (gameId) {
      clearFrontendAiSponsors(gameId);
    }
  }, [
    aiRuntimePreference,
    clearSponsoredFrontendSeats,
    clearFrontendAiSponsors,
    gameId,
  ]);

  useEffect(() => {
    if (!gameId || aiRuntimePreference !== "frontend") {
      return;
    }
    if (!localAiConfig.enabled) {
      return;
    }
    if (!view && seats.length === 0) {
      return;
    }
    if (restoredFrontendAiRef.current.has(gameId)) {
      return;
    }

    const seatIds = frontendAiSponsors[gameId] ?? [];
    if (seatIds.length === 0) {
      restoredFrontendAiRef.current.add(gameId);
      return;
    }

    for (const seatId of seatIds) {
      const viewSeat = view?.seats?.find((seat) => seat.seatId === seatId);
      const statusSeat = seats.find((seat) => seat.playerId === seatId);
      const runtime =
        viewSeat?.aiRuntime ??
        statusSeat?.aiRuntime ??
        (statusSeat?.isAi ? "backend" : "none");

      if (runtime === "backend") {
        forgetFrontendAiSponsorSeat(gameId, seatId);
        continue;
      }
      if (statusSeat?.occupied && runtime === "none") {
        forgetFrontendAiSponsorSeat(gameId, seatId);
        continue;
      }
      if (runtime === "frontend" && viewSeat?.isAiControlledByYou) {
        continue;
      }

      setSeatFrontendAi(gameId, seatId, true);
    }

    restoredFrontendAiRef.current.add(gameId);
  }, [
    aiRuntimePreference,
    forgetFrontendAiSponsorSeat,
    frontendAiSponsors,
    gameId,
    localAiConfig.enabled,
    seats,
    view,
  ]);

  const handleJoinAsSpectator = (isGodMode: boolean) => {
    if (!gameId) return;
    const spectatorId =
      playerId || `spectator-${Math.random().toString(36).slice(2, 8)}`;
    setPlayerId(spectatorId);
    rememberAndJoin(gameId, activeRulesId ?? "", spectatorId, "spectator", {
      isGodMode,
    });
    closeAll(300);
  };

  const handleJoinExisting = useCallback(
    (gType: string, gId: string) => {
      defaultRouteRef.current = null;
      const newPath = `/${gType}/${gId}`;
      window.history.pushState({}, "", newPath);
      setGameId(gId);
      setGameType(gType);
    },
    [setGameId, setGameType]
  );

  const handleManualJoin = (manualGameId: string, manualRulesId?: string) => {
    if (manualRulesId) {
      handleJoinExisting(manualRulesId, manualGameId);
      return;
    }
    const active = activeGames.find((g) => g.gameId === manualGameId);
    if (active) {
      handleJoinExisting(active.rulesId, manualGameId);
      return;
    }
    defaultRouteRef.current = null;
    setGameId(manualGameId);
  };

  const handleReset = () => {
    if (!gameId) return;
    restartGame(gameId);
    const isSpectator = view?.metadata?.role === "spectator";
    const allSeatsAutomated =
      seats.length > 0 && seats.every((seat) => seat.aiRuntime !== "none");
    const canSpectatorAutoStart = isSpectator && allSeatsAutomated;

    if (isCurrentPlayerSeated || canSpectatorAutoStart) {
      setAutoStartPending(true);
      markStartGamePending();
      setStartGamePendingKind("first");
      if (playerId) {
        // Fire start-game shortly after reset; clear suppression later when hasDealt turns true or timeout hits.
        setTimeout(() => {
          if (gameIdRef.current === gameId) {
            sendActionIntent(gameId, playerId, "start-game");
          }
        }, 100);
        setTimeout(() => {
          if (gameIdRef.current === gameId) {
            setAutoStartPending(false);
          }
        }, 10000);
      }
    }
  };

  const handleExitToLobby = useCallback(() => {
    const activeGameId = gameId;
    if (activeGameId) {
      clearSponsoredFrontendSeats();
      clearFrontendAiSponsors(activeGameId);
      if (playerId && view?.metadata?.role !== "spectator") {
        releaseSeat(activeGameId, playerId);
      }
      // 2) Tell server we left this game
      leaveGame();
    }

    // 1) Clear local game state first (always reset to avoid stale UI)
    setGameId("");
    setPlayerId(null);
    setSeats([]);
    setRoomSeed(null);
    setView(null);
    setGameType(null);
    setIsCreator(false);
    setJoinedGameId(null);
    lastJoinRef.current = null;

    // 3) Reset UI state atoms (scoreboard, actions, menus, etc.)
    closeAll();

    // 4) Clear any pending announcements from previous game
    clearAnnouncementPipeline();

    // Clear any route errors for clean navigation
    setRouteError(null);

    // 5) Navigate to lobby and refresh active games
    window.history.pushState({}, "", "/");
    fetchActiveGames()
      .then(setActiveGames)
      .catch((err) =>
        console.error("Failed to fetch active games after leaving game", err)
      );
  }, [
    clearSponsoredFrontendSeats,
    clearFrontendAiSponsors,
    clearAnnouncementPipeline,
    closeAll,
    gameId,
    playerId,
    setActiveGames,
    setGameId,
    setGameType,
    setIsCreator,
    setJoinedGameId,
    setPlayerId,
    setRoomSeed,
    setRouteError,
    setSeats,
    setView,
    view?.metadata?.role,
  ]);

  const handleExitToGameSelection = useCallback(() => {
    const targetRulesId = activeRulesId ?? rulesId ?? "";
    handleExitToLobby();

    if (!targetRulesId) return;
    const game = availableGames.find((entry) => entry.id === targetRulesId);
    if (game) {
      setSelectedGameForDetails(game);
    }
  }, [
    activeRulesId,
    rulesId,
    handleExitToLobby,
    availableGames,
    setSelectedGameForDetails,
  ]);

  const handleLeaveSeat = useCallback(() => {
    if (!gameId) return;
    if (view?.metadata?.role === "spectator") {
      handleExitToGameSelection();
      return;
    }

    if (playerId) {
      releaseSeat(gameId, playerId);
    }

    // 1. Tell server we are leaving (vacates seat and leaves socket room)
    leaveGame();

    // 2. Update recent games to remember we are no longer a player here.
    // This prevents the auto-join effect from immediately putting us back in the seat.
    setRecentGames((prev) =>
      prev.map((g) =>
        g.gameId === gameId ? { ...g, lastRole: "spectator" } : g
      )
    );

    // 3. Clear local player identity to trigger the selection overlay.
    setPlayerId(null);

    // 4. Clear view so the auto-join effect re-enters watch mode.
    setView(null);

    // 5. Reset joined status to trigger the auto-join effect.
    // It will see playerId is null and keep us in the room lobby.
    setJoinedGameId(null);

    safeStartViewTransition(() => setIsMenuOpen(false));
  }, [
    gameId,
    handleExitToGameSelection,
    playerId,
    view?.metadata?.role,
    setPlayerId,
    setRecentGames,
    setJoinedGameId,
    setIsMenuOpen,
    setView,
  ]);

  const handleStartGame = (rulesIdToStart: string, seed?: string) => {
    if (startingGameType) return;
    if (gameId) {
      leaveGame();
    }
    defaultRouteRef.current = null;
    setStartingGameType(rulesIdToStart);
    startGame(rulesIdToStart, seed);
  };

  const handleStartPublicRoom = (rulesIdToStart: string, seed?: string) => {
    if (startingGameType) return;
    if (gameId) {
      leaveGame();
    }
    defaultRouteRef.current = null;
    setStartingGameType(rulesIdToStart);
    startGame(rulesIdToStart, seed, { publicRoom: true });
  };

  // Card set handling: prefer the mobile-optimized deck on small screens, persist choice
  useEffect(() => {
    const stored = window.localStorage.getItem(CARD_SET_STORAGE_KEY);
    const storedSet = CARD_SETS.find((set) => set.id === stored);
    if (storedSet) {
      setCardSet(storedSet.id);
      return;
    }

    const prefersMobileDeck = window.matchMedia("(max-width: 640px)").matches;
    setCardSet(prefersMobileDeck ? DEFAULT_MOBILE_CARD_SET : DEFAULT_CARD_SET);
  }, [setCardSet]);

  useEffect(() => {
    window.localStorage.setItem(CARD_SET_STORAGE_KEY, cardSet);
  }, [cardSet]);

  // If the current game requires jokers, ensure our selected card set supports them.
  useEffect(() => {
    if (!gameMeta?.requiresJokers) return;
    const selected = CARD_SETS.find((set) => set.id === cardSet);
    if (selected?.supportsJokers) return;
    const fallback = allowedCardSets[0];
    if (fallback) setCardSet(fallback.id);
  }, [allowedCardSets, cardSet, gameMeta?.requiresJokers, setCardSet]);

  // Theme handling: default to system, allow manual override
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };
    setSystemPrefersDark(mql.matches);
    mql.addEventListener("change", listener);
    return () => {
      mql.removeEventListener("change", listener);
    };
  }, []);

  useEffect(() => {
    const resolved =
      themeSetting === "system"
        ? systemPrefersDark
          ? "dark"
          : "light"
        : themeSetting;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }, [themeSetting, systemPrefersDark]);

  // Handle escape key to clear card selection in test mode
  const [selectedCard, setSelectedCard] = useAtom(selectedCardAtom);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedCard) {
        sfx.playCardLower();
        setSelectedCard(null);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedCard, setSelectedCard]);

  const cycleTheme = () => {
    setThemeSetting((prev) =>
      prev === "system" ? "light" : prev === "light" ? "dark" : "system"
    );
  };

  const isGameActive = Boolean(gameId && playerId && view);
  const isSpectator = view?.metadata?.role === "spectator";
  const isIdentityEnabled =
    isIdentityEnabledOnClient() && serverIdentityEnabled;
  const identityMode = isIdentityEnabled ? identityState.mode : "guest";
  const identityLabel =
    identityMode === "user"
      ? (identityState.email ?? "signed-in-user")
      : `guest-${identityState.guestId.slice(-6)}`;
  const effectiveIsCreator = view?.metadata?.isHost === "true" || isCreator;
  const currentSeat = playerId
    ? (seats.find((seat) => seat.playerId === playerId) ?? null)
    : null;
  const currentSeatLabel =
    currentSeat?.name ?? currentSeat?.playerId ?? "Unknown";
  const roomTypeLabel =
    view?.metadata?.roomType ??
    activeGames.find((entry) => entry.gameId === gameId)?.roomType ??
    null;
  const activeGameSummary =
    activeGames.find((entry) => entry.gameId === gameId) ?? null;
  const saveStorage =
    (view?.metadata?.saveStorage ??
      activeGameSummary?.persistence?.storage ??
      null) === "supabase"
      ? "supabase"
      : null;
  const savePersistedAt =
    view?.metadata?.savePersistedAt ??
    activeGameSummary?.persistence?.persistedAt ??
    null;
  const saveHydratedFrom =
    (view?.metadata?.saveHydratedFrom ??
      activeGameSummary?.persistence?.hydratedFrom ??
      null) === "supabase"
      ? "supabase"
      : null;
  const lobbySeed = view?.metadata?.seed ?? roomSeed ?? null;
  const roomLobbyTitle = gameTitle ? `${gameTitle} Room Lobby` : "Room Lobby";
  const showRoomLobby =
    Boolean(gameId) &&
    (playerId === null ||
      (!hasGameStarted && (!isGameActive || !allSeatsJoined)));
  const showInRoomFallback = Boolean(gameId) && !isGameActive && !showRoomLobby;
  const rootLayoutClass = isLobbyView
    ? "relative w-full h-[100dvh] md:h-full"
    : "relative h-[100dvh] overflow-hidden touch-none";
  const contentLayoutClass = gameId
    ? "absolute inset-0 w-full h-full px-0 py-0"
    : isLobbyView
      ? "w-full flex flex-col items-stretch justify-start h-full"
      : "w-full h-full flex flex-col items-center justify-center";

  // Logic: Show pattern in Lobby or Error screens (!gameId).
  // Hide in Game (gameId present).
  // Use bg-fixed to prevent the pattern from scrolling with the content.
  const bgClasses = "";

  return (
    <main
      className={`font-sans text-ink bg-surface-1 ${rootLayoutClass} ${bgClasses}`}
    >
      <TestHUD />

      {/* Loading Overlay */}
      {!gameId && !routeError && isLobbyLoading && (
        <FullScreenMessage
          title="Loading games"
          description={
            <div className="flex w-full max-w-sm flex-col items-center gap-4">
              <div className="h-10 w-10 spinner" aria-hidden="true" />
              <div>Waking up the game server. This can take a few seconds.</div>
              <div className="mt-2 w-full rounded-xl border border-surface-3 bg-surface-1/70 p-3 text-left">
                <div className="mt-1 text-xs text-ink-muted">
                  Current:{" "}
                  <span className="font-mono break-all">{SERVER_URL}</span>
                </div>
                <div className="mt-3 min-h-[3rem] rounded-lg border border-surface-3/80 bg-surface-2/70 px-3 py-2 text-xs">
                  <div
                    className={
                      lobbyStatus.tone === "error"
                        ? "font-semibold text-red-500"
                        : lobbyStatus.tone === "warning"
                          ? "font-semibold text-amber-600"
                          : "font-semibold text-ink-muted"
                    }
                  >
                    {lobbyStatus.label}
                  </div>
                  <div
                    className={
                      lobbyStatus.tone === "error"
                        ? "mt-0.5 break-words text-red-500"
                        : lobbyStatus.tone === "warning"
                          ? "mt-0.5 break-words text-amber-600"
                          : "mt-0.5 break-words text-ink-muted"
                    }
                  >
                    {lobbyStatus.message}
                  </div>
                </div>
                <div className="mt-3">
                  <button
                    className="button-base rounded-full px-4 py-2 text-xs"
                    onClick={() =>
                      setIsServerSettingsExpanded((expanded) => !expanded)
                    }
                  >
                    {isServerSettingsExpanded
                      ? "Hide Server Settings"
                      : "Show Server Settings"}
                  </button>
                </div>
                {isServerSettingsExpanded && (
                  <>
                    <label className="mb-2 mt-3 block text-xs font-semibold text-ink-muted">
                      Backend Server (Override)
                    </label>
                    <input
                      type="text"
                      value={serverUrlInput}
                      onChange={(event) => {
                        setServerUrlInput(event.target.value);
                        setServerUrlInputError(null);
                      }}
                      placeholder="192.168.1.50:3000"
                      className="w-full rounded-lg border border-surface-3 bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-brand-500"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        className="button-base button-primary rounded-full px-4 py-2 text-xs"
                        onClick={applyServerUrlOverride}
                      >
                        Save and Retry
                      </button>
                      {hasServerUrlOverride && (
                        <button
                          className="button-base rounded-full px-4 py-2 text-xs"
                          onClick={resetServerUrlOverride}
                        >
                          Use Default
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          }
          translucent
          blurredOverlay
        />
      )}

      <div className={contentLayoutClass}>
        {/* 1. Game Not Found State */}
        {!gameId && routeError?.kind === "GAME_NOT_FOUND" && (
          <FullScreenMessage
            title="Game Not Found"
            tone="error"
            onClose={() => setRouteError(null)}
            description={
              <>
                The game you tried to open either never existed, has already
                finished, or has been cleaned up.
                {routeError.gameId && (
                  <div className="mt-2 text-xs font-mono opacity-70">
                    ID: {routeError.rulesId}/{routeError.gameId}
                  </div>
                )}
              </>
            }
            action={
              <button
                className="button-base button-primary px-8 py-3 rounded-full text-sm shadow-floating active:scale-95 transition-all"
                onClick={() => {
                  setRouteError(null);
                  fetchActiveGames()
                    .then(setActiveGames)
                    .catch((err) =>
                      console.error(
                        "Failed to fetch active games after Game Not Found",
                        err
                      )
                    );
                }}
              >
                Return to Home
              </button>
            }
            blurredOverlay
          />
        )}

        {/* LOBBY VIEW */}
        {!gameId && !routeError && (
          <LobbyScreen
            themeSetting={themeSetting}
            showSettings={showSettings}
            onToggleSettings={() => setShowSettings(!showSettings)}
            onCycleTheme={cycleTheme}
            aiRuntimePreference={aiRuntimePreference}
            onChangeAiRuntimePreference={setAiRuntimePreference}
            localAiConfig={localAiConfig}
            onChangeLocalAiConfig={setLocalAiConfig}
            serverAiEnabled={serverAiEnabled}
            onJoinManual={handleManualJoin}
            onRefreshLobby={refreshLobby}
            onGameSelect={handleGameSelect}
            onAboutClick={() => {
              setIsAboutFromMenu(false);
              setAboutVisible(true);
            }}
            isLobbyLoading={isLobbyLoading}
            identityWarning={identityWarning}
            identityMode={identityMode}
            identityLabel={identityLabel}
            isIdentityAvailable={isIdentityEnabled}
            authEmail={authEmailInput}
            authBusy={authBusy}
            authMessage={authMessage}
            onAuthEmailChange={(value) => setAuthEmailInput(value)}
            onSendMagicLink={handleSendMagicLink}
            onSignOut={handleSignOutIdentity}
            availableGames={availableGames}
            sortedAvailableGames={sortedAvailableGames}
            activeGames={activeGames}
            recentGames={recentGames}
            backendRuntime={backendRuntime}
          />
        )}

        {/* MODAL: Game Details */}
        {selectedGameForDetails && (
          <GameDetailsModal
            game={selectedGameForDetails}
            activeGames={activeGames}
            recentGames={recentGames}
            onClose={() => setSelectedGameForDetails(null)}
            onStart={(type, seed) => {
              handleStartGame(type, seed);
              setSelectedGameForDetails(null);
            }}
            onStartPublic={(type, seed) => {
              handleStartPublicRoom(type, seed);
              setSelectedGameForDetails(null);
            }}
            onJoin={(type, id) => {
              handleJoinExisting(type, id);
              setSelectedGameForDetails(null);
            }}
          />
        )}

        {/* Global Starting Game Overlay */}
        {startingGameType && !gameId && (
          <FullScreenMessage
            title={`Starting ${startingGameType}...`}
            description="Connecting to the game server and preparing your game session. This may take a few seconds."
            translucent
            blurredOverlay
          />
        )}

        {showRoomLobby && (
          <RoomLobbyOverlay
            title={roomLobbyTitle}
            gameId={gameId ?? ""}
            lobbySeed={lobbySeed}
            roomTypeLabel={roomTypeLabel}
            saveStorage={saveStorage}
            savePersistedAt={savePersistedAt}
            saveHydratedFrom={saveHydratedFrom}
            isCreator={effectiveIsCreator}
            isGameActive={isGameActive}
            allSeatsJoined={allSeatsJoined}
            isSpectator={isSpectator}
            isIdentityEnabled={isIdentityEnabled}
            isGodMode={view?.metadata?.isGodMode === "true"}
            playerId={playerId}
            seats={seats}
            joinAsGodMode={joinAsGodMode}
            effectiveAiPreference={effectiveAiPreference}
            currentSeatLabel={currentSeatLabel}
            identityLabel={identityLabel}
            identityMode={identityMode}
            onToggleGodMode={() => setJoinAsGodMode(!joinAsGodMode)}
            onJoinSeat={handleJoin}
            onJoinSpectator={handleJoinAsSpectator}
            onLeaveSeat={handleLeaveSeat}
            onApplyAiSetting={applyAiSettingForSeat}
            onForceReleaseSeat={handleForceReleaseSeat}
            onExitToSelection={handleExitToGameSelection}
            onShare={async () => {
              try {
                await shareGameInfo(gameTitle || undefined);
              } catch (err) {
                console.error("Failed to share game info", err);
              }
            }}
          />
        )}

        {/* Show game board */}
        {isGameActive && view && playerId && (
          <GameShell
            gameId={gameId}
            view={view}
            playerId={playerId}
            seats={seats}
            isConnected={isConnected}
            suppressStartOverlay={suppressStartOverlay}
            holdStartOverlay={holdStartOverlay}
            isStartGameBusy={startGameBusy}
            onStartGame={(isNextRound) => {
              setIsScoreboardOpen(false);
              markStartGamePending();
              setStartGamePendingKind(isNextRound ? "next" : "first");
            }}
            onSkipStartGameAnimations={requestSkipStartGameAnimations}
            overrideStartOverlayIsNextRound={startOverlayIsNextRoundOverride}
            highlightedWidget={highlightedWidget}
            isAnyEndOverlayVisible={isAnyEndOverlayVisible}
            headerTransitionCards={headerTransitionCards}
            isMenuOpen={isMenuOpen}
            onMenuClick={() =>
              safeStartViewTransition(() => setIsMenuOpen(!isMenuOpen))
            }
            onRulesClick={() => setRulesVisible(true)}
            onTurnBadgeClick={openAiLog}
            onActionsClick={() => {
              if (hasWidgetInLayout("actions")) {
                setHighlightedWidget("actions");
                setTimeout(() => setHighlightedWidget(null), 100);
              } else {
                setIsActionsOpen(!isActionsOpen);
              }
            }}
            onScoreboardClick={() => {
              if (hasScoreboardsInLayout) {
                setIsScoreboardOpen(false);
                setHighlightedWidget("scoreboards");
                setTimeout(() => setHighlightedWidget(null), 100);
                return;
              }
              setIsScoreboardOpen(!isScoreboardOpen);
            }}
            onActionsToggle={setIsActionsOpen}
            onScoreboardToggle={setIsScoreboardOpen}
            isActionsOpen={isActionsOpen}
            isScoreboardOpen={isScoreboardOpen}
            isActionsAttentionPulse={isActionsAttentionPulse}
            announcementItems={announcementItems}
            onAnnouncementComplete={handleAnnouncementComplete}
            onExitToSelection={handleExitToGameSelection}
            winnerLabel={gameMeta?.winnerLabel}
            onRestart={handleReset}
            onExit={handleExitToGameSelection}
            onExitSeat={handleLeaveSeat}
            onAboutClick={() => {
              setIsAboutFromMenu(true);
              setAboutVisible(true);
              safeStartViewTransition(() => setIsMenuOpen(false));
            }}
            onActionIntent={(action) =>
              sendActionIntent(gameId, playerId, action)
            }
            onEndOverlayMinimizedChange={setIsEndOverlayMinimized}
          />
        )}

        {isRulesVisible && (
          <RulesOverlay
            rulesId={view?.rulesId ?? rulesId ?? ""}
            onClose={() => setRulesVisible(false)}
          />
        )}

        {isAboutVisible && (
          <AboutOverlay
            onClose={() => {
              setAboutVisible(false);
              if (isAboutFromMenu) {
                setIsMenuOpen(true);
                setIsAboutFromMenu(false);
              }
            }}
            showBackArrow={isAboutFromMenu}
            backendRuntime={backendRuntime}
          />
        )}

        {gameId && (!view || !playerId) && isInitialGameLoad && (
          <LoadingOverlay message="Loading game..." />
        )}

        {showInRoomFallback && (
          <LoadingOverlay message="Returning to room lobby..." />
        )}
      </div>

      {/* Toast Notifications */}
      <div
        className="fixed bottom-4 right-4 z-[1100] flex flex-col gap-2 items-end pointer-events-none max-h-[calc(100vh-2rem)]"
        data-testid="status-message"
      >
        {!toastAutoCloseEnabled && activeToasts.length > 0 && (
          <button
            onClick={() => setActiveToasts([])}
            className="pointer-events-auto button-base button-secondary px-3 py-1.5 text-2xs uppercase tracking-wider shadow-lg bg-surface-1 border-surface-3 mb-1 flex-shrink-0"
          >
            Clear all
          </button>
        )}
        <div className="flex flex-col gap-2 items-end overflow-y-auto max-h-full pointer-events-none">
          {activeToasts.map((toast) => {
            const toneClass =
              toast.tone === "error"
                ? "border-error bg-error-surface text-error-ink"
                : toast.tone === "success"
                  ? "border-success bg-success-surface text-success-ink"
                  : toast.tone === "neutral"
                    ? "border-warning bg-warning-surface text-warning-ink"
                    : toast.tone === "warning"
                      ? "border-warning bg-warning-surface text-warning-ink"
                      : "border-surface-3 bg-surface-1 text-ink";

            return (
              <div
                key={toast.id}
                data-testid={
                  toast.tone === "error" ? "error-message" : "status-message"
                }
                className={`pointer-events-auto w-80 flex items-start justify-between gap-3 rounded-lg border-l-4 p-3 shadow-lg transition-all animate-toast-pop ${toneClass}`}
                aria-live={toast.tone === "error" ? "assertive" : "polite"}
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-2xs font-bold uppercase tracking-wider opacity-50">
                    {toast.source}
                  </span>
                  <span className="text-sm font-medium leading-snug">
                    {toast.message}
                  </span>
                </div>
                <button
                  onClick={() => removeToast(toast.id)}
                  className="p-1 -mr-1 text-current opacity-50 hover:opacity-100 hover:bg-black/5 rounded-full transition-all cursor-pointer"
                  type="button"
                  aria-label="Close notification"
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* 3. Offline State */}
      {!isConnected && (
        <FullScreenMessage
          title="Reconnecting"
          tone="neutral"
          description={
            <div className="flex flex-col items-center gap-6 py-2">
              <div className="text-lg font-medium">
                Reconnecting to your game, just a moment
                <span className="dots-loading" />
              </div>
              <div className="spinner h-10 w-10 border-4" />
            </div>
          }
          blurredOverlay
        />
      )}

      {/* Hidden debug panel for test automation */}
      <div data-testid="meta:debug-panel" className="sr-only">
        <div data-testid="meta:current-player">{view?.currentPlayer || ""}</div>
        <div data-testid="meta:currentPlayer">{view?.currentPlayer || ""}</div>
        <div data-testid="meta:gameId">{view?.gameId || ""}</div>
        <div data-testid="meta:playerId">{playerId || ""}</div>
        <div data-testid="meta:game-id">{view?.gameId || ""}</div>
        <div data-testid="meta:player-id">{playerId || ""}</div>
        <div data-testid="meta:phase">{view?.metadata?.phase ?? ""}</div>
        <div data-testid="meta:winner-label">{gameMeta?.winnerLabel ?? ""}</div>
      </div>
    </main>
  );
}
