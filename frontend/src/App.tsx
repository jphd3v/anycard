import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { GameRoot } from "./components/GameRoot";
import { FullScreenMessage } from "./components/FullScreenMessage";
import { FatalErrorOverlay } from "./components/FatalErrorOverlay";
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
  isMenuOpenAtom,
  isActionsOpenAtom,
  isScoreboardOpenAtom,
  toastAutoCloseEnabledAtom,
  aiRuntimePreferenceAtom,
  serverAiEnabledAtom,
  aiShowExceptionsAtom,
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
import { useGameMeta } from "./hooks/useGameMeta";
import {
  fetchActiveGames,
  fetchAvailableGames,
  fetchServerConfig,
  joinGame,
  watchGame,
  leaveGame,
  restartGame,
  setupSocketHandlers,
  setupConnectionHandlers,
  connect,
  startGame,
  sendActionIntent,
  setSeatAsAi,
  setSeatFrontendAi,
} from "./socket";
import { sfx } from "./utils/audio";
import { shareGameInfo } from "./utils/share";
import type {
  CardView,
  GameView,
  GameLayout,
  ViewEventPayload,
  LayoutZone,
  AnnounceAnchor,
  PileLayout,
} from "../../shared/schemas";
import { GameHUD } from "./components/GameHUD";
import { GameHeader } from "./components/GameHeader";
import { FloatingWidget } from "./components/FloatingWidget";
import { RulesOverlay } from "./components/RulesOverlay";
import { AboutOverlay } from "./components/AboutOverlay";
import { WinnerOverlay } from "./components/WinnerOverlay";
import { LoadingOverlay } from "./components/LoadingOverlay";
import {
  FloatingActionOverlay,
  type FloatingActionItem,
} from "./components/FloatingActionOverlay";
import { useAiLog } from "./hooks/useAiLog";
import { useGameLayout } from "./hooks/useGameLayout";
import { choosePileSorter, sortCardsForDisplay } from "./utils/pileSort";
import {
  SuitDivider,
  TopCornerOrnaments,
  BottomCornerOrnaments,
} from "./components/Lobby/SuitDecorations";
import { GameListItem } from "./components/Lobby/GameListItem";
import { GameDetailsModal } from "./components/Lobby/GameDetailsModal";
import { AiSettings } from "./components/Lobby/AiSettings";
import { JoinGameInput } from "./components/Lobby/JoinGameInput";
import { LobbyFooter } from "./components/Lobby/LobbyFooter";
import { useMenuControls } from "./hooks/useMenuControls";
import { useGameTitle } from "./hooks/useGameTitle";

type ParsedRoute =
  | { kind: "explicit"; rulesId: string; gameId: string }
  | { kind: "default"; rulesId: string }
  | null;

type IncomingStatePayload = GameView;
type AnnounceViewEvent = Extract<ViewEventPayload, { type: "announce" }>;

function applyViewEventToView(
  prev: GameView,
  event: ViewEventPayload,
  finalView: GameView,
  options?: {
    animateOnlyCards?: boolean;
  }
): GameView {
  const animateOnlyCards = options?.animateOnlyCards ?? false;

  // Start with previous state but pull in metadata from the final authoritative view
  // because metadata often contains derived state (like phase) that doesn't have
  // explicit events but should be consistent with the move.
  const next = {
    ...prev,
    metadata: finalView.metadata,
  };

  switch (event.type) {
    case "move-cards": {
      const { fromPileId, toPileId, cardIds } = event;

      const idSet = new Set(cardIds);
      const eventCardById = new Map(
        event.cardViews?.map((card) => [card.id, card]) ?? []
      );

      // 1. Capture cards from the source pile in the previous view,
      //    preserving source order.
      const fromPile = prev.piles.find((p) => p.id === fromPileId);
      let movedCards =
        fromPile?.cards.filter((card) => idSet.has(card.id)) ?? [];

      // 2. Build a lookup of the final card views from the authoritative view.
      //    This is where orientation (faceDown) is correct for the target pile.
      const finalCardById = new Map<number, (typeof movedCards)[number]>();
      for (const pile of finalView.piles) {
        for (const card of pile.cards) {
          if (idSet.has(card.id)) {
            finalCardById.set(card.id, card);
          }
        }
      }

      // 3. Replace movedCards with their final representation when available.
      if (finalCardById.size > 0 || eventCardById.size > 0) {
        movedCards = movedCards.map((card) => {
          const eventCard = eventCardById.get(card.id);
          const finalCard = finalCardById.get(card.id);
          const targetCard = eventCard ?? finalCard;
          if (!targetCard) {
            return card;
          }
          if (card.faceDown && !targetCard.faceDown) {
            // Keep the card back while it moves; flip after settling.
            return { ...targetCard, faceDown: true };
          }
          if (!card.faceDown && targetCard.faceDown) {
            // Keep the face-up front during travel; flip after movement settles.
            return {
              id: targetCard.id,
              label: card.label ?? targetCard.label,
              rank: card.rank ?? targetCard.rank,
              suit: card.suit ?? targetCard.suit,
              faceDown: false,
              rotationDeg: targetCard.rotationDeg ?? card.rotationDeg,
            };
          }
          return targetCard;
        });
      }

      const piles = prev.piles.map((pile) => {
        if (pile.id === fromPileId) {
          // Remove moved cards from source
          return {
            ...pile,
            cards: pile.cards.filter((card) => !idSet.has(card.id)),
          };
        }
        if (pile.id === toPileId) {
          // Append moved cards to destination using their final orientation
          return {
            ...pile,
            cards: [...pile.cards, ...movedCards],
          };
        }
        return pile;
      });

      return { ...next, piles };
    }

    case "set-current-player":
      if (animateOnlyCards) {
        return { ...next, currentPlayer: finalView.currentPlayer ?? null };
      }
      return { ...next, currentPlayer: event.player ?? null };

    case "set-winner":
      if (animateOnlyCards) {
        return { ...next, winner: finalView.winner ?? null };
      }
      return { ...next, winner: event.winner ?? null };

    case "set-scoreboards":
      if (animateOnlyCards) {
        return next;
      }
      return { ...next, scoreboards: event.scoreboards };

    case "set-actions":
      if (animateOnlyCards) {
        return next;
      }
      return { ...next, actions: event.actions };

    case "set-rules-state":
      if (animateOnlyCards) {
        return next;
      }
      return { ...next, rulesState: event.rulesState };

    case "set-pile-visibility": {
      const pileId = event.pileId;
      const finalPile = finalView.piles.find((p) => p.id === pileId);
      if (!finalPile) {
        return next;
      }
      const piles = prev.piles.map((pile) =>
        pile.id === pileId ? { ...pile, cards: finalPile.cards } : pile
      );
      return { ...next, piles };
    }

    case "announce":
      return next;

    case "fatal-error":
      // Fatal errors are handled by setting the error state atom,
      // but we return the state unchanged since the error is global
      return next;

    default:
      // Unknown event types are ignored for now
      return next;
  }
}

function applyOptimisticDragMove(
  prev: GameView,
  move: PendingDragMove
): GameView {
  const fromPile = prev.piles.find((pile) => pile.id === move.fromPileId);
  const toPile = prev.piles.find((pile) => pile.id === move.toPileId);
  if (!fromPile || !toPile) {
    return prev;
  }
  const cardIndex = fromPile.cards.findIndex((card) => card.id === move.cardId);
  if (cardIndex === -1) {
    return prev;
  }
  const movingCard = fromPile.cards[cardIndex];

  const piles = prev.piles.map((pile) => {
    if (pile.id === move.fromPileId) {
      return {
        ...pile,
        cards: pile.cards.filter((card) => card.id !== move.cardId),
      };
    }
    if (pile.id === move.toPileId) {
      return {
        ...pile,
        cards: [...pile.cards, movingCard],
      };
    }
    return pile;
  });

  return { ...prev, piles };
}

function applyMoveRevealToView(
  prev: GameView,
  event: ViewEventPayload
): GameView {
  if (event.type !== "move-cards" || !event.cardViews?.length) {
    return prev;
  }

  const revealById = new Map(event.cardViews.map((card) => [card.id, card]));
  let changed = false;

  const piles = prev.piles.map((pile) => {
    let nextCards = pile.cards;
    for (let idx = 0; idx < pile.cards.length; idx += 1) {
      const card = pile.cards[idx];
      const reveal = revealById.get(card.id);
      if (!reveal) continue;
      if (
        card.faceDown === reveal.faceDown &&
        card.label === reveal.label &&
        card.rank === reveal.rank &&
        card.suit === reveal.suit &&
        card.rotationDeg === reveal.rotationDeg
      ) {
        continue;
      }
      if (nextCards === pile.cards) {
        nextCards = [...pile.cards];
      }
      nextCards[idx] = reveal;
      changed = true;
    }
    if (nextCards === pile.cards) {
      return pile;
    }
    return { ...pile, cards: nextCards };
  });

  if (!changed) {
    return prev;
  }

  return { ...prev, piles };
}

function getCardViewsForIds(view: GameView, cardIds: number[]): CardView[] {
  if (cardIds.length === 0) {
    return [];
  }

  const idSet = new Set(cardIds);
  const cardById = new Map<number, CardView>();

  for (const pile of view.piles) {
    for (const card of pile.cards) {
      if (idSet.has(card.id)) {
        cardById.set(card.id, card);
      }
    }
  }

  const ordered: CardView[] = [];
  for (const cardId of cardIds) {
    const card = cardById.get(cardId);
    if (card) {
      ordered.push(card);
    }
  }

  return ordered;
}

function normalizePileLayout(val?: string): PileLayout | undefined {
  return val === "horizontal" ||
    val === "vertical" ||
    val === "complete" ||
    val === "spread"
    ? (val as PileLayout)
    : undefined;
}

function hasGameDealt(view: GameView | null): boolean {
  if (
    !view ||
    typeof view.rulesState !== "object" ||
    view.rulesState === null
  ) {
    return false;
  }
  const maybeHasDealt = (view.rulesState as { hasDealt?: unknown }).hasDealt;
  return typeof maybeHasDealt === "boolean" ? maybeHasDealt : false;
}

function parseRouteFromLocation(
  location: Location = window.location
): ParsedRoute {
  const path = location.pathname.replace(/^\/+/, "");
  if (!path) return null;

  const [rulesId, gameId] = path.split("/");
  if (!rulesId) return null;

  if (!gameId) {
    return { kind: "default", rulesId };
  }

  return { kind: "explicit", rulesId, gameId };
}

function getDynamicDuration(queueLength: number, isMyTurn: boolean): number {
  // If we are live (no backlog), always animate fully so the user sees what happened,
  // even if it becomes their turn.
  if (queueLength === 0) return 1000;

  // If we are catching up from a backlog:
  if (isMyTurn) return 0; // Snap immediately if we are behind and it becomes my turn
  if (queueLength > 2) return 200; // Very fast catch-up
  return 500; // Brisk pace
}

const DEFAULT_CARD_FLIP_MS = 320;
const MAX_TRANSITION_CARDS_PER_PILE = 24;
const MAX_TRANSITION_CARDS = 80;
const MAX_HEADER_TRANSITION_CARDS = 8;

type PileTransitionConfig = {
  layoutsByPileId: Record<string, string | undefined>;
  isHandByPileId: Record<string, boolean>;
  hasSortByPileId: Record<string, boolean>;
};

function buildPileTransitionConfig(
  layout: GameLayout | null
): PileTransitionConfig {
  const layoutsByPileId: Record<string, string | undefined> = {};
  const isHandByPileId: Record<string, boolean> = {};
  const hasSortByPileId: Record<string, boolean> = {};

  const pileStyles = layout?.pileStyles ?? {};
  for (const [pileId, style] of Object.entries(pileStyles)) {
    layoutsByPileId[pileId] = style.layout;
    isHandByPileId[pileId] = !!style.isHand;
    hasSortByPileId[pileId] = !!style.sort;
  }

  return { layoutsByPileId, isHandByPileId, hasSortByPileId };
}

function shouldAnimatePileReflow(
  pileId: string,
  view: GameView,
  config: PileTransitionConfig
): boolean {
  const basePile = view.piles.find((pile) => pile.id === pileId);
  const baseLayout = normalizePileLayout(basePile?.layout);
  const overrideLayout = normalizePileLayout(config.layoutsByPileId[pileId]);
  const layout = baseLayout ?? overrideLayout ?? "complete";

  if (layout === "spread") {
    return true;
  }
  if (layout === "horizontal" || layout === "vertical") {
    return config.isHandByPileId[pileId] || config.hasSortByPileId[pileId];
  }
  return false;
}

function didPileOrderChange(
  pileId: string,
  prevView: GameView,
  nextView: GameView
): boolean {
  const prevPile = prevView.piles.find((pile) => pile.id === pileId);
  const nextPile = nextView.piles.find((pile) => pile.id === pileId);
  if (!prevPile || !nextPile) {
    return false;
  }
  if (prevPile.cards.length !== nextPile.cards.length) {
    return true;
  }
  for (let i = 0; i < prevPile.cards.length; i += 1) {
    if (prevPile.cards[i]?.id !== nextPile.cards[i]?.id) {
      return true;
    }
  }
  return false;
}

function sortViewPiles(
  view: GameView,
  layout: GameLayout | null,
  selections: Record<string, string>
): GameView {
  if (!layout || !layout.pileStyles) return view;

  const nextPiles = view.piles.map((pile) => {
    const style = layout.pileStyles?.[pile.id];
    if (!style || !style.sort) return pile;

    const sortConfig = style.sort;
    const optionIds = sortConfig.options?.map((o) => o.id) ?? [];
    const fallbackSortId =
      sortConfig.default && optionIds.includes(sortConfig.default)
        ? sortConfig.default
        : optionIds[0];

    const selectedSortId =
      selections[pile.id] && optionIds.includes(selections[pile.id])
        ? selections[pile.id]
        : fallbackSortId;

    const { sorter } = choosePileSorter(sortConfig, selectedSortId);
    const sortedCards = sortCardsForDisplay(
      pile.cards,
      sorter,
      normalizePileLayout(pile.layout) ??
        normalizePileLayout(style.layout) ??
        "complete"
    );

    return { ...pile, cards: sortedCards };
  });

  return { ...view, piles: nextPiles };
}

function parseDurationMs(value: string, fallback: number): number {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (trimmed.endsWith("ms")) {
    const ms = Number.parseFloat(trimmed.slice(0, -2));
    return Number.isFinite(ms) ? ms : fallback;
  }
  if (trimmed.endsWith("s")) {
    const sec = Number.parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(sec) ? sec * 1000 : fallback;
  }
  const raw = Number.parseFloat(trimmed);
  return Number.isFinite(raw) ? raw : fallback;
}

function getCardFlipDurationMs(): number {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return DEFAULT_CARD_FLIP_MS;
  }
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return 0;
  }
  const cssValue = getComputedStyle(document.documentElement).getPropertyValue(
    "--card-flip-duration"
  );
  return parseDurationMs(cssValue, DEFAULT_CARD_FLIP_MS);
}

function waitMs(durationMs: number): Promise<void> {
  if (durationMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs);
  });
}

const DEFAULT_LOBBY_SEED = "ESC0Q0";
const CARD_SET_STORAGE_KEY = "card-set-preference";
const MAX_RECENT_GAMES = 10;

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
  const setServerAiEnabled = useSetAtom(serverAiEnabledAtom);
  const setAiShowExceptions = useSetAtom(aiShowExceptionsAtom);
  const serverAiEnabled = useAtomValue(serverAiEnabledAtom);
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
  const setFatalError = useSetAtom(fatalErrorAtom);
  const setAiLog = useSetAtom(aiLogAtom);
  const [startingGameType, setStartingGameType] = useState<string | null>(null);
  const [isCreator, setIsCreator] = useState(false);
  const [joinedGameId, setJoinedGameId] = useState<string | null>(null);
  const [joinAsGodMode, setJoinAsGodMode] = useState(false);
  const [isInitialGameLoad, setIsInitialGameLoad] = useState(true);
  const [isLobbyLoading, setIsLobbyLoading] = useState(true);

  const [themeSetting, setThemeSetting] = useAtom(themeSettingAtom);
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const [autoStartPending, setAutoStartPending] = useState(false);
  const [highlightedWidget, setHighlightedWidget] = useState<
    "actions" | "scoreboards" | null
  >(null);
  const [headerTransitionCards, setHeaderTransitionCards] = useState<
    CardView[]
  >([]);
  const [announcementItems, setAnnouncementItems] = useState<
    FloatingActionItem[]
  >([]);
  const pendingDragMove = useAtomValue(pendingDragMoveAtom);
  const pendingDragMoveRef = useRef<PendingDragMove | null>(null);

  useEffect(() => {
    pendingDragMoveRef.current = pendingDragMove;
  }, [pendingDragMove]);

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
    }
  }, [lastAction, setAiLog, view?.rulesState]);

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
  const [isActionsOpen, setIsActionsOpen] = useAtom(isActionsOpenAtom);
  const [isScoreboardOpen, setIsScoreboardOpen] = useAtom(isScoreboardOpenAtom);
  const [toastAutoCloseEnabled, setToastAutoCloseEnabled] = useAtom(
    toastAutoCloseEnabledAtom
  );
  const allSeatsAutomated = useAtomValue(allSeatsAutomatedAtom);
  const { openAiLog } = useAiLog();
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

  const isNextRoundOverlayVisible =
    !!view?.gameId &&
    !!playerId &&
    allSeatsJoined &&
    !hasGameDealt(view) &&
    isNextRound &&
    !view?.winner;

  const isAnyEndOverlayVisible =
    isWinnerOverlayVisible || isNextRoundOverlayVisible;

  // Auto-open scoreboard when game/round ends if it's a widget
  useEffect(() => {
    if (isAnyEndOverlayVisible && !hasWidgetInLayout("scoreboards")) {
      setIsScoreboardOpen(true);
    }
  }, [isAnyEndOverlayVisible, hasWidgetInLayout, setIsScoreboardOpen]);

  // Update document title based on current game state
  useEffect(() => {
    if (gameTitle && gameId) {
      document.title = `AnyCard - ${gameTitle}`;
    } else {
      document.title = "AnyCard";
    }
  }, [gameTitle, gameId]);

  // Close open widgets on orientation change
  useEffect(() => {
    const handleResize = () => {
      closeAll();
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
  const lastHasDealtRef = useRef(false);
  const [hasSeenNotDealt, setHasSeenNotDealt] = useState(false);

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

  const sortedAvailableGames = [...availableGames].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );

  const initialRoute = parseRouteFromLocation();

  const [hasInitializedFromRoute, setHasInitializedFromRoute] = useState(false);
  const defaultRouteRef = useRef<string | null>(
    initialRoute?.kind === "default" ? initialRoute.rulesId : null
  );
  const lobbyRetryTimerRef = useRef<number | null>(null);
  const lobbyCancelledRef = useRef(false);
  const lastJoinRef = useRef<{
    gameId: string;
    rulesId: string;
    playerId: string;
    role: "player" | "spectator";
    isGodMode?: boolean;
    roomType?: "demo" | "public" | "private";
  } | null>(null);
  const wasDisconnectedRef = useRef(false);

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

  const isCurrentPlayerSeated =
    !!playerId &&
    seats.some((seat) => seat.playerId === playerId && seat.occupied);
  const suppressStartOverlay = autoStartPending;

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

  // Auto-join effect
  useEffect(() => {
    // No game selected or we already know the route is invalid → do nothing
    if (!gameId || routeError) return;

    // We already joined this gameId (once) → do not auto-join again
    if (joinedGameId === gameId) {
      return;
    }

    // Decide who to join as
    let pid = "";
    const role: "player" | "spectator" = "player";
    const recentEntry = recentGames.find((entry) => entry.gameId === gameId);
    const rulesIdForJoin = rulesId ?? "";
    const isDefaultRoute =
      !!rulesIdForJoin && window.location.pathname === `/${rulesIdForJoin}`;

    if (recentEntry?.lastRole === "player") {
      pid = recentEntry.lastPlayerId;
      if (playerId !== pid) {
        setPlayerId(pid);
      }

      rememberAndJoin(gameId, rulesIdForJoin, pid, role, undefined, {
        roomType: isDefaultRoute ? "demo" : undefined,
      });
      return;
    }

    if (view) {
      return;
    }

    if (playerId !== null) {
      setPlayerId(null);
    }
    setJoinedGameId(gameId);
    watchGame(gameId);
  }, [
    gameId,
    view,
    playerId,
    joinedGameId,
    routeError,
    rememberAndJoin,
    recentGames,
    rulesId,
    setJoinedGameId,
    setPlayerId,
  ]);

  // Connection handling
  useEffect(() => {
    return setupConnectionHandlers(
      () => setIsConnected(true),
      () => setIsConnected(false)
    );
  }, [setIsConnected]);

  useEffect(() => {
    if (!isConnected) {
      wasDisconnectedRef.current = true;
      return;
    }
    if (wasDisconnectedRef.current) {
      attemptRejoin();
      wasDisconnectedRef.current = false;
    }
  }, [attemptRejoin, isConnected]);

  // Monitor browser network state for immediate disconnection detection
  useEffect(() => {
    const handleOnline = () => {
      setIsConnected(true);
      connect();
    };
    const handleOffline = () => {
      setIsConnected(false);
    };

    if (!navigator.onLine) {
      setIsConnected(false);
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [setIsConnected]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        connect();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (hasInitializedFromRoute) return;

    if (!initialRoute) {
      setHasInitializedFromRoute(true);
      return;
    }

    const availableGames = availableGamesAtomValue ?? [];
    const hasAvailableGames = availableGames.length > 0;

    // Wait for available games before deciding what to do with the route.
    // This avoids trying to start games for completely unknown types.
    if (!hasAvailableGames) {
      return;
    }

    const isKnownType = availableGames.some(
      (g) => g.id === initialRoute.rulesId
    );

    if (!isKnownType) {
      // Unknown game rules id → treat as invalid and show the same 404 overlay
      setRouteError({
        kind: "GAME_NOT_FOUND",
        gameId: initialRoute.kind === "explicit" ? initialRoute.gameId : "",
        rulesId: initialRoute.rulesId,
      });

      // Normalize the URL back to root so the user is clearly "in the lobby"
      try {
        window.history.replaceState({}, "", "/");
      } catch (err) {
        console.warn("Failed to replaceState after invalid initial route", err);
      }

      setHasInitializedFromRoute(true);
      return;
    }

    // Valid game rules id routes
    if (initialRoute.kind === "explicit") {
      setGameType(initialRoute.rulesId);
      setGameId(initialRoute.gameId);
      setHasInitializedFromRoute(true);
      return;
    }

    if (initialRoute.kind === "default") {
      defaultRouteRef.current = initialRoute.rulesId;
      void ensureDefaultGameForType(initialRoute.rulesId);
      setHasInitializedFromRoute(true);
    }
  }, [
    hasInitializedFromRoute,
    initialRoute,
    setGameId,
    setGameType,
    availableGamesAtomValue,
    ensureDefaultGameForType,
    setRouteError,
  ]);

  // Handle browser back/forward navigation
  useEffect(() => {
    const handlePopState = () => {
      const route = parseRouteFromLocation();

      // If there is no game in the URL → go to lobby
      if (!route) {
        // If we were in a game, leave it
        if (gameIdRef.current) {
          leaveGame();
        }

        setGameId("");
        setGameType(null);
        setPlayerId(null);
        setSeats([]);
        setRoomSeed(null);
        setView(null);
        setJoinedGameId(null);
        lastJoinRef.current = null;
        setRouteError(null);

        // Refresh lobby games
        fetchActiveGames()
          .then(setActiveGames)
          .catch((err) => {
            console.error("Failed to fetch active games after popstate", err);
          });

        return;
      }

      // We have a game route in the URL
      const availableGames = availableGamesAtomValue ?? [];
      const hasAvailableGames = availableGames.length > 0;
      const isKnownType = hasAvailableGames
        ? availableGames.some((g) => g.id === route.rulesId)
        : true; // Don't reject routes until games are loaded

      if (!isKnownType) {
        // Unknown game rules id: → treat as invalid and show error overlay
        if (gameIdRef.current) {
          leaveGame();
        }

        setGameId("");
        setGameType(null);
        setSeats([]);
        setRoomSeed(null);
        setView(null);
        setPlayerId(null);
        setJoinedGameId(null);
        lastJoinRef.current = null;

        setRouteError({
          kind: "GAME_NOT_FOUND",
          gameId: route.kind === "explicit" ? route.gameId : "",
          rulesId: route.rulesId,
        });

        try {
          window.history.replaceState({}, "", "/");
        } catch (err) {
          console.warn("Failed to replaceState after invalid game route", err);
        }

        return;
      }

      if (route.kind === "explicit") {
        defaultRouteRef.current = null;
        setRouteError(null);
        setGameType(route.rulesId);
        setGameId(route.gameId);
        setJoinedGameId(null); // allow auto-join effect to re-run for this game
        return;
      }

      defaultRouteRef.current = route.rulesId;
      setRouteError(null);
      setJoinedGameId(null);
      void ensureDefaultGameForType(route.rulesId);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [
    availableGamesAtomValue,
    setGameId,
    setGameType,
    setSeats,
    setRoomSeed,
    setView,
    setPlayerId,
    setRouteError,
    setJoinedGameId,
    setActiveGames,
    ensureDefaultGameForType,
  ]);

  const loadLobbyData = useCallback(async () => {
    setIsLobbyLoading(true);
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
  ]);

  // Fetch available games when the app starts
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

  // Poll active games every 5 seconds when in lobby
  useEffect(() => {
    if (gameId || routeError) return;

    const intervalId = setInterval(async () => {
      if (document.hidden) return;
      try {
        const active = await fetchActiveGames();
        setActiveGames(active);
      } catch (err) {
        console.error("Failed to poll active games", err);
      }
    }, 5000);

    return () => clearInterval(intervalId);
  }, [gameId, routeError, setActiveGames]);

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

  // When clicking a game in the list
  const handleGameSelect = (game: AvailableGame) => {
    setSelectedGameForDetails(game);
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

  const queueAnnouncement = useCallback(
    (event: AnnounceViewEvent) => {
      window.requestAnimationFrame(() => {
        const { x, y } = resolveAnnouncementPosition(event.anchor);
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setAnnouncementItems((prev) => [
          ...prev,
          { id, label: event.text, x, y },
        ]);
      });
    },
    [resolveAnnouncementPosition]
  );

  const handleAnnouncementComplete = useCallback((id: string) => {
    setAnnouncementItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const clearHighlightsTimerRef = useRef<number | null>(null);

  // Stable socket setup that doesn't tear down on gameId changes
  useEffect(() => {
    const processStatePayload = async (
      payload: IncomingStatePayload,
      generation: number,
      duration: number = 1000,
      remainingInQueue: number = 0
    ) => {
      const pileSortSelections = store.get(pileSortSelectionsAtom);

      // Set the CSS variable for transition duration
      document.documentElement.style.setProperty(
        "--transition-duration",
        `${duration}ms`
      );

      const startViewTransition = (
        document as Document & {
          startViewTransition?: (
            callback: () => void
          ) => { finished?: Promise<unknown> } | void;
        }
      ).startViewTransition?.bind(document);

      let prevView = lastAuthoritativeViewRef.current;
      const events = payload.lastViewEvents ?? [];
      const pendingMove = pendingDragMoveRef.current;
      const pendingMoveForGame =
        pendingMove && pendingMove.gameId === payload.gameId
          ? pendingMove
          : null;
      const hasMatchingDragMoveEvent = !!(
        pendingMoveForGame &&
        events.some(
          (event) =>
            event.type === "move-cards" &&
            event.fromPileId === pendingMoveForGame.fromPileId &&
            event.toPileId === pendingMoveForGame.toPileId &&
            event.cardIds.includes(pendingMoveForGame.cardId)
        )
      );
      if (pendingMoveForGame) {
        setPendingDragMove(null);
        pendingDragMoveRef.current = null;
      }
      if (prevView && pendingMoveForGame && hasMatchingDragMoveEvent) {
        // Keep optimistic drag moves in the base view so non-move events don't
        // snap the card back before the server move arrives.
        const prevViewRaw = applyOptimisticDragMove(
          prevView,
          pendingMoveForGame
        );
        prevView = sortViewPiles(
          prevViewRaw,
          gameLayoutRef.current,
          pileSortSelections
        );
      }
      const lastAction = payload.lastAction;

      const fatalErrors = payload.lastFatalErrors ?? [];
      if (fatalErrors.length > 0) {
        const fatalError = fatalErrors[0];
        setFatalError({
          message: fatalError.message,
          source: fatalError.source,
        });
      } else {
        setFatalError(null);
      }

      const animationEvents = events.filter(
        (event) => event.type !== "fatal-error"
      );
      const queueAnnouncements = (eventsToQueue: ViewEventPayload[]) => {
        for (const event of eventsToQueue) {
          if (event.type === "announce") {
            queueAnnouncement(event);
          }
        }
      };

      const nextViewRaw: GameView = {
        ...payload,
        lastEngineEvents: undefined,
        lastViewEvents: undefined,
        lastFatalErrors: undefined,
      };
      const nextView = sortViewPiles(
        nextViewRaw,
        gameLayoutRef.current,
        pileSortSelections
      );

      const scheduleClearHighlights = () => {
        if (clearHighlightsTimerRef.current) {
          window.clearTimeout(clearHighlightsTimerRef.current);
        }
        clearHighlightsTimerRef.current = window.setTimeout(() => {
          setHighlightedActionId(null);
          setHighlightedActionLabel(null);
          setHighlightedScoreboardCells({});
          clearHighlightsTimerRef.current = null;
        }, 900);
      };

      let pendingScoreboardHighlights: Record<string, string[]> | null = null;

      if (
        lastAction &&
        lastAction.action !== "start-game" &&
        playerId &&
        lastAction.playerId !== playerId
      ) {
        setHighlightedActionId(lastAction.action);
        setHighlightedActionLabel(lastAction.label ?? lastAction.action);
      }

      if (duration > 0 && remainingInQueue <= 6 && prevView) {
        const prevById = new Map(prevView.scoreboards.map((sb) => [sb.id, sb]));
        const nextHighlights: Record<string, string[]> = {};

        for (const nextSb of nextView.scoreboards) {
          const prevSb = prevById.get(nextSb.id);
          if (!prevSb) continue;

          const prevTextByPos = new Map<string, string>();
          for (const cell of prevSb.cells) {
            prevTextByPos.set(`${cell.row}:${cell.col}`, cell.text);
          }

          const changed: string[] = [];
          for (const cell of nextSb.cells) {
            const key = `${nextSb.id}:${cell.row}:${cell.col}`;
            const prevText = prevTextByPos.get(`${cell.row}:${cell.col}`);
            if (prevText !== undefined && prevText !== cell.text) {
              changed.push(key);
            }
          }

          if (changed.length > 0) {
            nextHighlights[nextSb.id] = changed;
          }
        }

        if (Object.keys(nextHighlights).length > 0) {
          pendingScoreboardHighlights = nextHighlights;
        }
      }

      const canAnimate =
        !!startViewTransition && document.visibilityState === "visible";

      const hasCardMoveEvent = animationEvents.some(
        (event) => event.type === "move-cards"
      );

      if (hasCardMoveEvent && duration > 0) {
        sfx.playCardMove();
      }

      // Fallback: no View Transition API, document hidden, or no previous view/events or instant duration (0ms)
      if (
        !canAnimate ||
        !prevView ||
        animationEvents.length === 0 ||
        duration === 0 ||
        !hasCardMoveEvent
      ) {
        if (pendingScoreboardHighlights) {
          setHighlightedScoreboardCells((prev) => ({
            ...prev,
            ...pendingScoreboardHighlights,
          }));
        }
        scheduleClearHighlights();
        lastAuthoritativeViewRef.current = nextView;
        setView(nextView);
        setActiveTransitionCardIds(null);
        setHeaderTransitionCards([]);
        queueAnnouncements(animationEvents);
        return;
      }

      // Avoid animating during setup/deal phases
      if (!hasGameDealt(prevView)) {
        lastAuthoritativeViewRef.current = nextView;
        setView(nextView);
        setActiveTransitionCardIds(null);
        setHeaderTransitionCards([]);
        queueAnnouncements(animationEvents);
        return;
      }

      // Animate by applying engine events on top of the previous view.
      // Each state change runs inside a view transition so CSS View Transitions
      // can animate DOM diffs between steps.
      let workingView = prevView;
      const flipPauseMs =
        duration > 0 && remainingInQueue === 0 ? getCardFlipDurationMs() : 0;
      const lastMoveIndex = animationEvents.reduce((last, event, index) => {
        if (event.type === "move-cards" && event.cardIds.length > 0) {
          return index;
        }
        return last;
      }, -1);
      let pendingFlipPause = false;

      // Trigger the action animation (FloatingActionOverlay) immediately before card moves
      if (
        duration > 0 &&
        workingView &&
        nextView.lastAction &&
        nextView.lastAction.id !== workingView.lastAction?.id
      ) {
        workingView = {
          ...workingView,
          lastAction: nextView.lastAction,
        };
        flushSync(() => {
          setView(workingView);
        });
      }

      for (let index = 0; index < animationEvents.length; index += 1) {
        const event = animationEvents[index];
        if (event.type !== "move-cards" || event.cardIds.length === 0) {
          const beforeView = workingView;
          flushSync(() => {
            const nextWorkingViewRaw = applyViewEventToView(
              workingView,
              event,
              nextView,
              {
                animateOnlyCards: true,
              }
            );
            workingView = sortViewPiles(
              nextWorkingViewRaw,
              gameLayoutRef.current,
              pileSortSelections
            );
            lastAuthoritativeViewRef.current = workingView;
            setView(workingView);
            setActiveTransitionCardIds(null);
            setHeaderTransitionCards([]);
          });

          if (event.type === "set-pile-visibility") {
            const beforePile = beforeView.piles.find(
              (p) => p.id === event.pileId
            );
            const afterPile = workingView.piles.find(
              (p) => p.id === event.pileId
            );
            if (beforePile && afterPile) {
              const hasFlip = beforePile.cards.some((card, idx) => {
                const afterCard = afterPile.cards[idx];
                return afterCard ? card.faceDown !== afterCard.faceDown : false;
              });
              if (hasFlip) {
                sfx.playCardFlip();
              }
            }
          }

          if (event.type === "announce") {
            queueAnnouncement(event);
          }
          continue;
        }

        const movingIds = new Set<number>(event.cardIds);
        const nextWorkingViewRaw = applyViewEventToView(
          workingView,
          event,
          nextView,
          {
            animateOnlyCards: true,
          }
        );
        const nextWorkingView = sortViewPiles(
          nextWorkingViewRaw,
          gameLayoutRef.current,
          pileSortSelections
        );

        const visiblePileIds = visiblePileIdsRef.current;
        const pileTransitionConfig = pileTransitionConfigRef.current;
        const fromVisible = visiblePileIds.has(event.fromPileId);
        const toVisible = visiblePileIds.has(event.toPileId);
        const entryCardsRaw =
          !fromVisible && toVisible
            ? getCardViewsForIds(nextWorkingView, event.cardIds)
            : [];
        const exitCardsRaw =
          fromVisible && !toVisible
            ? getCardViewsForIds(nextWorkingView, event.cardIds)
            : [];
        const entryCards =
          entryCardsRaw.length > MAX_HEADER_TRANSITION_CARDS
            ? []
            : entryCardsRaw;
        const exitCards =
          exitCardsRaw.length > MAX_HEADER_TRANSITION_CARDS ? [] : exitCardsRaw;
        const hasHeaderAnchors = entryCards.length > 0 || exitCards.length > 0;

        flushSync(() => {
          const transitionIds = new Set<number>(movingIds);
          const addPileCards = (pileId: string) => {
            if (!visiblePileIds.has(pileId)) {
              return;
            }
            const pile = workingView.piles.find((p) => p.id === pileId);
            if (!pile || pile.cards.length > MAX_TRANSITION_CARDS_PER_PILE) {
              return;
            }
            if (
              !shouldAnimatePileReflow(
                pileId,
                workingView,
                pileTransitionConfig
              )
            ) {
              return;
            }
            if (!didPileOrderChange(pileId, workingView, nextWorkingView)) {
              return;
            }
            for (const card of pile.cards) {
              transitionIds.add(card.id);
            }
          };

          addPileCards(event.fromPileId);
          addPileCards(event.toPileId);

          if (transitionIds.size > MAX_TRANSITION_CARDS) {
            transitionIds.clear();
            for (const id of movingIds) {
              transitionIds.add(id);
              if (transitionIds.size >= MAX_TRANSITION_CARDS) {
                break;
              }
            }
          }

          setActiveTransitionCardIds(transitionIds);
          setHeaderTransitionCards(entryCards);
        });

        let transition: { finished?: Promise<unknown> } | void;
        try {
          transition = startViewTransition(() => {
            flushSync(() => {
              setHeaderTransitionCards(exitCards);
              workingView = nextWorkingView;
              lastAuthoritativeViewRef.current = workingView;
              setView(workingView);
            });
          });
        } catch {
          // If a transition cannot start (hidden tab or overlapping transition), apply immediately
          flushSync(() => {
            setActiveTransitionCardIds(null);
            setHeaderTransitionCards([]);
            workingView = nextWorkingView;
            lastAuthoritativeViewRef.current = workingView;
            setView(workingView);
          });
          continue;
        }

        // Chain transitions if the browser provides a finished promise
        try {
          await (transition as { finished?: Promise<void> })?.finished;
        } catch {
          // Ignore transition errors; continue to next step
        }

        const revealViewRaw = applyMoveRevealToView(workingView, event);
        const revealView = sortViewPiles(
          revealViewRaw,
          gameLayoutRef.current,
          pileSortSelections
        );
        const didReveal = revealView !== workingView;
        let hasFlip = false;
        if (didReveal) {
          const beforeCards = getCardViewsForIds(workingView, event.cardIds);
          const afterCards = getCardViewsForIds(revealView, event.cardIds);
          hasFlip = beforeCards.some((card, idx) => {
            const nextCard = afterCards[idx];
            return nextCard ? card.faceDown !== nextCard.faceDown : false;
          });
        }
        if (hasFlip) {
          sfx.playCardFlip();
        }
        if (didReveal || hasHeaderAnchors) {
          flushSync(() => {
            if (didReveal) {
              workingView = revealView;
              lastAuthoritativeViewRef.current = workingView;
              setView(workingView);
            }
            if (hasHeaderAnchors) {
              setHeaderTransitionCards([]);
            }
          });
        }
        if (hasFlip && flipPauseMs > 0) {
          if (index < lastMoveIndex) {
            await waitMs(flipPauseMs);
          } else {
            pendingFlipPause = true;
          }
        }
      }

      // Final sanity step: ensure we end up at the authoritative server view
      if (pendingFlipPause && flipPauseMs > 0) {
        await waitMs(flipPauseMs);
      }
      try {
        const finalTransition = startViewTransition(() => {
          flushSync(() => {
            setActiveTransitionCardIds(null);
            setHeaderTransitionCards([]);
            lastAuthoritativeViewRef.current = nextView;
            setView(nextView);
            if (pendingScoreboardHighlights) {
              setHighlightedScoreboardCells((prev) => ({
                ...prev,
                ...pendingScoreboardHighlights,
              }));
            }
          });
        });

        try {
          await (finalTransition as { finished?: Promise<void> })?.finished;
        } catch {
          // Ignore
        }
      } catch {
        // If a transition cannot start, just apply the final state immediately
        flushSync(() => {
          setActiveTransitionCardIds(null);
          setHeaderTransitionCards([]);
          lastAuthoritativeViewRef.current = nextView;
          setView(nextView);
          if (pendingScoreboardHighlights) {
            setHighlightedScoreboardCells((prev) => ({
              ...prev,
              ...pendingScoreboardHighlights,
            }));
          }
        });
      }

      scheduleClearHighlights();
    };

    const processQueue = async () => {
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;

      while (stateQueueRef.current.length > 0) {
        // Peek at the next state to decide speed
        const nextPayload = stateQueueRef.current[0]; // Don't shift yet
        const remainingInQueue = stateQueueRef.current.length - 1;

        // Check if this state makes it MY turn
        const becomesMyTurn = nextPayload.currentPlayer === playerId;

        // Calculate speed based on backlog and whether it's my turn
        const duration = getDynamicDuration(remainingInQueue, becomesMyTurn);

        // Apply speed
        document.documentElement.style.setProperty(
          "--transition-duration",
          `${duration}ms`
        );

        // Shift and Process
        const payload = stateQueueRef.current.shift()!;
        const generation = ++stateGenerationRef.current;
        await processStatePayload(
          payload,
          generation,
          duration,
          remainingInQueue
        );
      }

      isProcessingRef.current = false;
    };

    return setupSocketHandlers({
      onState: (payload) => {
        setStartingGameType(null);
        setGameType(payload.rulesId);

        // Push new payload to state queue and trigger processing
        stateQueueRef.current.push(payload);
        void processQueue();
      },
      onStatus: (message) => {
        if (message.tone === "error") {
          setStartingGameType(null);
          if (message.message === "You are not joined to any game") {
            attemptRejoin();
          }
          if (
            message.message === "Game not found" ||
            message.message === "Game not found. Returning to lobby." ||
            message.message === "Game not found. Returning to Home."
          ) {
            // Handle this in onGameNotFound instead
            return;
          }
          const isJoinError =
            message.message === "Invalid join payload" ||
            message.message === "Player seat not recognized" ||
            message.message ===
              "Seat is controlled by AI; disable AI to take this seat" ||
            message.message.startsWith("Seat ") ||
            message.message === "Seat not found";
          if (isJoinError) {
            const currentGameId = gameIdRef.current;
            if (currentGameId) {
              removeRecentGame(currentGameId);
              setPlayerId(null);
              setJoinedGameId(null);
              lastJoinRef.current = null;
            }
          }
        }
        showStatus(message);
      },
      onSeats: (payload) => {
        const currentGameId = gameIdRef.current;
        if (
          payload.gameId === currentGameId ||
          (currentGameId === "" && payload.gameId !== "")
        ) {
          setSeats(payload.seats);
          setRoomSeed(payload.seed ?? null);
          setIsInitialGameLoad(false);
          if (currentGameId === "" && payload.gameId !== "") {
            setGameId(payload.gameId);
          }
        }
      },
      onEvaluationComplete: () => {
        setIsEvaluating(false);
      },
      onGameStartSuccess: (payload) => {
        setStartingGameType(null);
        setIsCreator(true);
        setGameId(payload.gameId);
        setGameType(payload.rulesId);

        // For magic routes (/bridge, /durak), keep the URL stable at /<rulesId>
        if (defaultRouteRef.current !== payload.rulesId) {
          const newPath = `/${payload.rulesId}/${payload.gameId}`;
          if (window.location.pathname !== newPath) {
            window.history.pushState({}, "", newPath);
          }
        }
      },
      onGameEnded: () => {
        setAiLog([]);
      },
      onGameNotFound: () => {
        // Only handle this once; if routeError already set, ignore
        if (routeError?.kind === "GAME_NOT_FOUND") return;

        const badGameId =
          gameIdRef.current ||
          (initialRoute?.kind === "explicit" ? initialRoute.gameId : "");
        const badGameType = initialRoute?.rulesId;

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
          rulesId: badGameType,
        });

        // Navigate to root *once*; use replaceState to avoid growing history
        try {
          window.history.replaceState({}, "", "/");
        } catch (err) {
          // Some Safari builds can be picky here; ignore failures
          console.warn("Failed to replaceState after Game not found", err);
        }
      },
      onInvalidMove: () => {
        if (lastAuthoritativeViewRef.current) {
          setView(lastAuthoritativeViewRef.current);
        }
        setActiveTransitionCardIds(null);
        setHeaderTransitionCards([]);
        setPendingDragMove(null);
        pendingDragMoveRef.current = null;
      },
      onAiLog: (payload) => {
        setAiLog((prev) => [...prev, ...payload.entries]);
      },
    });
  }, [
    attemptRejoin,
    initialRoute,
    routeError,
    setActiveTransitionCardIds,
    setHeaderTransitionCards,
    setGameId,
    setGameType,
    setIsEvaluating,
    setIsInitialGameLoad,
    setSeats,
    setRoomSeed,
    setFatalError,
    setStartingGameType,
    setView,
    setPendingDragMove,
    playerId,
    showStatus,
    setAiLog,
    removeRecentGame,
    setJoinedGameId,
    setPlayerId,
    setHighlightedActionId,
    setHighlightedActionLabel,
    setHighlightedScoreboardCells,
    queueAnnouncement,
    store,
  ]); // Removed gameId from dependencies to prevent listener teardown race

  const handleJoin = (selectedPlayerId: string) => {
    if (!gameId) return;
    setPlayerId(selectedPlayerId);
    rememberAndJoin(gameId, activeRulesId ?? "", selectedPlayerId, "player");
  };

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
          return;
        }
        setSeatAsAi(gameId, seatId, false);
        return;
      }

      if (effectiveAiPreference === "frontend") {
        setLocalAiConfig((prev) => ({ ...prev, enabled: true }));
        setSeatAsAi(gameId, seatId, false);
        setSeatFrontendAi(gameId, seatId, true);
        return;
      }

      // backend preference
      if (isFrontendSeat) {
        disableFrontendSeat();
      }
      setSeatAsAi(gameId, seatId, true);
    },
    [effectiveAiPreference, gameId, setLocalAiConfig, view]
  );

  const clearSponsoredFrontendSeats = useCallback(() => {
    if (!gameId || !view?.seats) {
      return;
    }

    for (const seat of view.seats) {
      if (seat.aiRuntime === "frontend" && seat.isAiControlledByYou) {
        setSeatFrontendAi(gameId, seat.seatId, false);
      }
    }
  }, [gameId, view]);

  useEffect(() => {
    if (aiRuntimePreference === "frontend") return;
    clearSponsoredFrontendSeats();
  }, [aiRuntimePreference, clearSponsoredFrontendSeats]);

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
    if (gameId) {
      clearSponsoredFrontendSeats();
      // 1) Clear local game state first
      setGameId("");
      setPlayerId(null);
      setSeats([]);
      setRoomSeed(null);
      setView(null);
      setGameType(null);
      setIsCreator(false);
      setJoinedGameId(null);
      lastJoinRef.current = null;

      // 2) Tell server we left this game
      leaveGame();

      // 3) Reset UI state atoms (scoreboard, actions, menus, etc.)
      closeAll();

      // 4) Clear any pending announcements from previous game
      setAnnouncementItems([]);
    }

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
    closeAll,
    gameId,
    setActiveGames,
    setAnnouncementItems,
    setGameId,
    setGameType,
    setIsCreator,
    setJoinedGameId,
    setPlayerId,
    setRoomSeed,
    setRouteError,
    setSeats,
    setView,
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

    setIsMenuOpen(false);
  }, [
    gameId,
    handleExitToGameSelection,
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

  const cycleCardSet = () => {
    const list = allowedCardSets.length > 0 ? allowedCardSets : CARD_SETS;
    const currentIndex = list.findIndex((set) => set.id === cardSet);
    const nextSet = list[(currentIndex + 1) % list.length] ?? list[0];
    if (nextSet) setCardSet(nextSet.id);
  };

  const cardSetLabel =
    allowedCardSets.find((set) => set.id === cardSet)?.label ??
    CARD_SETS.find((set) => set.id === cardSet)?.label ??
    CARD_SETS.find((set) => set.id === DEFAULT_CARD_SET)?.label ??
    cardSet;

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

  const themeLabel =
    themeSetting === "system"
      ? `System`
      : themeSetting === "light"
        ? "Light"
        : "Dark";

  const isLobbyView = !gameId && !routeError;
  const isGameActive = Boolean(gameId && playerId && view);
  const isSpectator = view?.metadata?.role === "spectator";
  const seatsFilledCount = seats.filter((seat) => {
    const runtime = seat.aiRuntime ?? (seat.isAi ? "backend" : "none");
    return seat.occupied || runtime !== "none";
  }).length;
  const currentSeat = playerId
    ? (seats.find((seat) => seat.playerId === playerId) ?? null)
    : null;
  const currentSeatLabel =
    currentSeat?.name ?? currentSeat?.playerId ?? "Unknown";
  const roomTypeLabel =
    view?.metadata?.roomType ??
    activeGames.find((entry) => entry.gameId === gameId)?.roomType ??
    null;
  const lobbySeed = view?.metadata?.seed ?? roomSeed ?? null;
  const roomLobbyTitle = gameTitle ? `${gameTitle} Room Lobby` : "Room Lobby";
  const showRoomLobby =
    Boolean(gameId) && !hasGameStarted && (!isGameActive || !allSeatsJoined);
  const rootLayoutClass = isLobbyView
    ? "relative w-full h-full"
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
            <div className="flex flex-col items-center gap-4">
              <div className="h-10 w-10 spinner" aria-hidden="true" />
              <div>Waking up the game server. This can take a few seconds.</div>
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
          <div className="flex-1 w-full flex flex-col max-w-lg landscape:max-w-none landscape:px-12 mx-auto h-full overflow-y-auto relative bg-surface-1 scrollbar-hide">
            <header className="relative pt-12 pb-2 px-6 text-center z-10 shrink-0">
              <TopCornerOrnaments />
              <h1 className="text-5xl md:text-6xl font-serif-display font-black text-ink mb-2 tracking-tight drop-shadow-sm relative z-10">
                AnyCard
              </h1>
              <p className="text-sm font-medium text-ink-muted uppercase tracking-[0.2em] opacity-80 relative z-10">
                Universal Card Game Engine
              </p>

              <div className="relative z-10 mt-4 flex items-center justify-center gap-2">
                <button
                  onClick={cycleTheme}
                  className="button-base button-ghost flex items-center gap-1.5 px-3 py-1.5 text-ink-muted hover:text-ink hover:bg-surface-2 transition-colors rounded-lg"
                  title="Toggle Theme"
                >
                  <span className="text-sm font-medium">Theme</span>
                  {themeSetting === "system" ? (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={1.5}
                      stroke="currentColor"
                      className="w-4 h-4"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25"
                      />
                    </svg>
                  ) : themeSetting === "dark" ? (
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
                        d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                      />
                    </svg>
                  ) : (
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
                        d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                      />
                    </svg>
                  )}
                </button>
                <div className="w-px h-4 bg-surface-3"></div>
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  className={`button-base button-ghost flex items-center gap-1.5 px-3 py-1.5 transition-colors rounded-lg ${
                    showSettings
                      ? "text-primary bg-primary/10"
                      : "text-ink-muted hover:text-ink hover:bg-surface-2"
                  }`}
                  title="Configure AI & Settings"
                >
                  <span className="text-sm font-medium">Config</span>
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
                      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                </button>
              </div>

              {showSettings && (
                <div className="relative z-10 mt-4 mx-4 p-4 bg-surface-1 border border-surface-3 rounded-xl shadow-lg animate-in slide-in-from-top-2">
                  <AiSettings
                    preference={aiRuntimePreference}
                    onChangePreference={setAiRuntimePreference}
                    aiConfig={localAiConfig}
                    onChangeAiConfig={setLocalAiConfig}
                    serverAiEnabled={serverAiEnabled}
                  />
                </div>
              )}

              <div className="relative z-10">
                <SuitDivider />
              </div>
            </header>

            <div className="shrink-0 z-10 flex flex-col relative">
              <div className="px-4 flex-1">
                <JoinGameInput onJoin={handleManualJoin} />
                {!isLobbyLoading && availableGames.length === 0 && (
                  <div className="text-center py-12 px-6 rounded-2xl border-2 border-dashed border-surface-3 bg-surface-1/50">
                    <p className="text-ink-muted mb-4">The library is empty.</p>
                    <button
                      onClick={() => loadLobbyData()}
                      className="button-base button-secondary px-4 py-2 text-sm"
                    >
                      Refresh
                    </button>
                  </div>
                )}
                <div className="grid grid-cols-1 landscape:grid-cols-2 gap-3 pb-8">
                  {sortedAvailableGames.map((game) => (
                    <GameListItem
                      key={game.id}
                      game={game}
                      activeCount={
                        activeGames.filter(
                          (g) => g.rulesId === game.id && g.status === "playing"
                        ).length
                      }
                      seatedCount={
                        recentGames.filter(
                          (rg) =>
                            rg.rulesId === game.id &&
                            rg.lastRole === "player" &&
                            activeGames.some((ag) => ag.gameId === rg.gameId)
                        ).length
                      }
                      onClick={() => handleGameSelect(game)}
                    />
                  ))}
                </div>
              </div>
              <div className="relative mt-auto flex flex-col justify-end pt-2 pb-2">
                <BottomCornerOrnaments />
                <div className="relative z-10">
                  <LobbyFooter onAboutClick={() => setAboutVisible(true)} />
                </div>
              </div>
            </div>
          </div>
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
          <FullScreenMessage
            title={roomLobbyTitle}
            panelClassName={`seat-selection-panel !max-w-[480px] !w-full !p-4 sm:!p-6 ${!isGameActive ? "!bg-surface-1" : ""}`}
            descriptionClassName="!text-ink !mb-4 sm:!mb-6"
            translucent={isGameActive}
            canMinimize={isGameActive}
            onClose={!isGameActive ? handleExitToGameSelection : undefined}
            blockInteractionsWhenMinimized={true}
            description={
              <div
                className="seat-selection-body flex flex-col w-full mx-auto text-xs sm:text-sm"
                style={{
                  gap: "clamp(12px, 3vw, 20px)",
                }}
              >
                {(() => {
                  if (effectiveAiPreference !== "off") return null;

                  return (
                    <div className="text-2xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 text-center">
                      AI runtime is Off. Enable it from the Home Config to
                      toggle AI seats.
                    </div>
                  );
                })()}

                {seats.some((seat) => seat.aiRuntime === "frontend") && (
                  <div className="text-2xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 text-center">
                    Warning: Frontend AI runs in a browser and can see hidden
                    info.
                  </div>
                )}

                {/* Room Status Badge */}

                <div className="flex flex-col gap-1.5 items-center my-1">
                  <div className="flex gap-2 items-center">
                    <span
                      className={`px-2 py-0.5 rounded text-2xs font-bold uppercase tracking-wider ${isCreator ? "bg-green-100 text-green-700 border border-green-200" : "bg-blue-100 text-blue-700 border border-blue-200"}`}
                    >
                      {isCreator
                        ? "Room Created"
                        : isGameActive
                          ? "Room Joined"
                          : "Room Found"}
                    </span>

                    {roomTypeLabel && (
                      <span className="px-2 py-0.5 rounded text-2xs font-black uppercase tracking-tighter bg-primary/10 text-primary border border-primary/20">
                        {roomTypeLabel}
                      </span>
                    )}

                    <div className="flex items-center gap-1">
                      <span className="text-xs font-mono text-ink-muted bg-surface-2 px-2 py-0.5 rounded border border-surface-3">
                        ID: {gameId}
                      </span>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await shareGameInfo(gameTitle || undefined);
                          } catch (err) {
                            console.error("Failed to share game info", err);
                          }
                        }}
                        className="button-base button-icon button-secondary h-6 w-6 flex items-center justify-center"
                        title="Share game"
                      >
                        <svg
                          className="h-3.5 w-3.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                          <polyline points="16,6 12,2 8,6" />
                          <line x1="12" y1="2" x2="12" y2="15" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {lobbySeed && (
                    <div className="text-2xs text-ink-muted/70 font-mono italic">
                      Seed: {lobbySeed}
                    </div>
                  )}
                </div>

                <div className="flex flex-col items-center gap-2">
                  {isGameActive ? (
                    <div className="flex flex-col items-center gap-2">
                      {isSpectator ? (
                        <div className="text-sm sm:text-base font-medium flex items-center justify-center flex-wrap gap-x-1 gap-y-1">
                          <span>
                            You are watching as a{" "}
                            <span className="text-primary font-bold">
                              spectator
                              {view?.metadata?.isGodMode === "true" && (
                                <span className="ml-1 opacity-60 font-normal">
                                  (God mode)
                                </span>
                              )}
                            </span>
                          </span>
                          <button
                            onClick={handleLeaveSeat}
                            className="px-1.5 py-0.5 text-2xs font-bold uppercase tracking-wider text-red-600/80 hover:text-red-600 hover:bg-red-50 transition-all cursor-pointer rounded underline underline-offset-2 decoration-dotted active:scale-95"
                          >
                            (leave)
                          </button>
                        </div>
                      ) : (
                        <div className="text-sm sm:text-base font-medium flex items-center justify-center flex-wrap gap-x-1 gap-y-1">
                          <span>
                            You have taken a seat:{" "}
                            <span className="text-primary font-bold">
                              {currentSeatLabel}
                            </span>
                          </span>
                          <button
                            onClick={handleLeaveSeat}
                            className="px-1.5 py-0.5 text-2xs font-bold uppercase tracking-wider text-red-600/80 hover:text-red-600 hover:bg-red-50 transition-all cursor-pointer rounded underline underline-offset-2 decoration-dotted active:scale-95"
                          >
                            (leave)
                          </button>
                        </div>
                      )}
                      <p className="text-xs sm:text-sm text-ink-muted text-center">
                        Waiting for other players to join the room before the
                        game can begin.
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-2">
                      <div className="text-sm sm:text-base font-medium text-center">
                        Choose a seat to join this room.
                      </div>
                      <p className="text-xs sm:text-sm text-ink-muted text-center">
                        You can also watch as a spectator if you just want to
                        observe.
                      </p>
                    </div>
                  )}
                </div>

                {seats.length > 0 && (
                  <div className="flex flex-col gap-1.5 items-center w-full max-w-xs">
                    <div className="text-xs font-bold uppercase tracking-widest text-ink-muted">
                      Seats filled: {seatsFilledCount} / {seats.length}
                    </div>
                  </div>
                )}

                {seats.length === 0 ? (
                  <div className="text-xs text-ink-muted text-center">
                    Loading seats...
                  </div>
                ) : (
                  <div
                    className="seat-selection-grid grid grid-cols-1 min-[440px]:grid-cols-2 w-full"
                    style={{ gap: "clamp(10px, 3vw, 14px)" }}
                  >
                    {seats.map((seat) => {
                      const aiRuntime =
                        seat.aiRuntime ?? (seat.isAi ? "backend" : "none");

                      const isAiSeat = aiRuntime !== "none";

                      const isBrowserAi = aiRuntime === "frontend";
                      const isSeatMine =
                        playerId === seat.playerId && !isSpectator;
                      const isHumanOccupied = seat.occupied && !isAiSeat;
                      const isHumanOccupiedByOther =
                        isHumanOccupied && !isSeatMine;

                      const isJoinLocked = isAiSeat || isHumanOccupied;

                      const canEnableAiSeat = effectiveAiPreference !== "off";
                      // Backend AI: Can't enable AI on your own seat
                      // Frontend AI: Can enable AI on your own seat (sponsoring)
                      const aiToggleDisabled =
                        (isSeatMine && effectiveAiPreference === "backend") ||
                        (!canEnableAiSeat && !isAiSeat);

                      return (
                        <div
                          key={seat.playerId}
                          data-testid={`seat-card:${seat.playerId}`}
                          className={`

                                  seat-selection-card relative w-full rounded-xl border-2 transition-all flex flex-col items-stretch

                                  ${
                                    isJoinLocked
                                      ? "bg-surface-2 border-surface-3 opacity-80"
                                      : "bg-surface-1 border-surface-3 hover:border-primary/30 hover:bg-surface-1/80"
                                  }

                                `}
                          style={{
                            padding: "clamp(10px, 2.5vw, 16px)",

                            gap: "clamp(8px, 2vw, 12px)",
                          }}
                        >
                          <div className="w-full font-semibold text-xs sm:text-sm md:text-base text-ink flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-center">
                            <span className="truncate">
                              {seat.name ?? seat.playerId}
                            </span>

                            {/* AI Status Text */}

                            {isAiSeat && (
                              <span className="text-2xs text-indigo-600 font-medium bg-indigo-50 rounded px-1 py-0.5">
                                {isBrowserAi ? "AI (browser)" : "AI (server)"}
                              </span>
                            )}
                          </div>

                          {isJoinLocked ? (
                            <div
                              data-testid={`seat-state:${seat.playerId}`}
                              data-state={
                                playerId === seat.playerId ? "me" : "occupied"
                              }
                              className="w-full min-h-[36px] flex items-stretch"
                            >
                              <div className="w-full px-2 py-0.5 bg-surface-3 text-ink-muted text-2xs font-semibold uppercase tracking-wide rounded-full text-center flex items-center justify-center">
                                {isAiSeat
                                  ? "AI Controlled"
                                  : isSeatMine
                                    ? "Your Seat"
                                    : "Occupied"}
                              </div>
                            </div>
                          ) : (
                            <div
                              data-testid={`seat-state:${seat.playerId}`}
                              data-state="open"
                              className="w-full min-h-[36px] flex items-stretch"
                            >
                              <button
                                onClick={() => handleJoin(seat.playerId)}
                                data-testid={`seat-join:${seat.playerId}`}
                                className="button-base button-primary mx-auto w-fit px-6 h-full min-h-[36px] text-xs shadow-sm hover:shadow-md"
                              >
                                Join Game
                              </button>
                            </div>
                          )}

                          {/* AI Control Toggle */}

                          <div
                            className={`w-full flex items-center justify-between pt-1 sm:pt-1.5 border-t border-surface-3/50 ${
                              isHumanOccupiedByOther
                                ? "opacity-50 pointer-events-none"
                                : ""
                            }`}
                          >
                            <span className="text-2xs font-medium text-ink-muted">
                              AI Player
                            </span>

                            <button
                              type="button"
                              data-testid={`seat-ai-toggle:${seat.playerId}`}
                              disabled={aiToggleDisabled}
                              onClick={() =>
                                applyAiSettingForSeat(seat.playerId, !isAiSeat)
                              }
                              className={`

                                      relative inline-flex h-4 w-8 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50

                                      ${isAiSeat ? "bg-indigo-600" : "bg-surface-3"}

                                      ${
                                        aiToggleDisabled
                                          ? "opacity-50 cursor-not-allowed"
                                          : "cursor-pointer"
                                      }

                                    `}
                            >
                              <span
                                className={`

                                        inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform

                                        ${isAiSeat ? "translate-x-4" : "translate-x-1"}

                                      `}
                              />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {!isSpectator && (
                  <div
                    className="seat-selection-actions flex flex-col items-center w-full mt-2"
                    style={{ gap: "clamp(12px, 3vw, 16px)" }}
                  >
                    <div className="w-full bg-surface-1 border-2 border-surface-3 rounded-xl p-3 flex flex-col sm:flex-row items-center justify-between gap-3 transition-all hover:border-primary/30 hover:bg-surface-1/80">
                      <div className="flex items-center gap-2 order-2 sm:order-1">
                        <div
                          className="flex items-center gap-2 text-xs font-medium text-ink cursor-pointer select-none"
                          onClick={() => setJoinAsGodMode(!joinAsGodMode)}
                        >
                          <button
                            type="button"
                            role="switch"
                            aria-checked={joinAsGodMode}
                            className={`

                                    relative inline-flex h-4 w-8 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/50

                                    ${joinAsGodMode ? "bg-blue-600" : "bg-surface-3"}

                                  `}
                          >
                            <span
                              className={`

                                      inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform

                                      ${
                                        joinAsGodMode
                                          ? "translate-x-4"
                                          : "translate-x-1"
                                      }

                                    `}
                            />
                          </button>

                          <span>Enable God Mode</span>
                        </div>
                      </div>

                      <button
                        onClick={() => handleJoinAsSpectator(joinAsGodMode)}
                        className="button-base button-secondary text-xs px-6 py-2 w-fit mx-auto sm:w-auto font-bold shadow-sm order-1 sm:order-2"
                      >
                        Watch as Spectator
                      </button>
                    </div>
                  </div>
                )}

                <button
                  onClick={handleExitToGameSelection}
                  className="mt-2 px-3 py-1.5 text-2xs sm:text-xs font-bold uppercase tracking-widest text-ink-muted hover:text-ink hover:bg-surface-2 transition-all cursor-pointer rounded-lg border border-transparent hover:border-surface-3 active:scale-95 active:bg-surface-3/50 underline underline-offset-4 decoration-dotted"
                >
                  Back to game selection
                </button>
              </div>
            }
          />
        )}

        {/* Show game board */}
        {isGameActive && view && playerId && (
          <div className="game-layout flex flex-col h-full w-full overflow-hidden">
            <GameHeader
              className={isAnyEndOverlayVisible ? "z-[1100]" : "z-50"}
              isOverlayActive={isAnyEndOverlayVisible}
              transitionCards={headerTransitionCards}
              onMenuClick={() => setIsMenuOpen(!isMenuOpen)}
              isMenuOpen={isMenuOpen}
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
                if (hasWidgetInLayout("scoreboards")) {
                  setHighlightedWidget("scoreboards");
                  setTimeout(() => setHighlightedWidget(null), 100);
                } else {
                  setIsScoreboardOpen(!isScoreboardOpen);
                }
              }}
              isActionsOpen={isActionsOpen}
              isScoreboardOpen={isScoreboardOpen}
            />
            <div className="flex-1 relative overflow-hidden">
              <GameRoot
                view={view}
                playerId={playerId}
                disabled={!isConnected}
                suppressStartOverlay={suppressStartOverlay}
                highlightedWidget={highlightedWidget}
              />
              <FloatingActionOverlay
                actions={announcementItems}
                onComplete={handleAnnouncementComplete}
                durationMs={2800}
              />
              {gameId && (
                <FatalErrorOverlay
                  gameId={gameId}
                  onExitToSelection={handleExitToGameSelection}
                />
              )}
              <WinnerOverlay
                winnerId={view.winner}
                seats={seats}
                onRestart={handleReset}
                onExit={handleExitToGameSelection}
              />
              <GameHUD
                gameId={gameId}
                isOpen={isMenuOpen}
                setIsOpen={setIsMenuOpen}
                onExit={handleLeaveSeat}
                onReset={handleReset}
                onChangeTheme={cycleTheme}
                themeLabel={themeLabel}
                onChangeCardSet={cycleCardSet}
                cardSetLabel={cardSetLabel}
                onAboutClick={() => {
                  setAboutVisible(true);
                  setIsMenuOpen(false);
                }}
              />
              <div
                className={`header-floating-panel fixed top-16 right-2 sm:right-4 pointer-events-none flex flex-col items-end ${isAnyEndOverlayVisible ? "z-[1110]" : "z-[70]"}`}
              >
                {/* Header-triggered Scoreboard Panel */}
                <div className="header-panel-slot" data-open={isScoreboardOpen}>
                  <FloatingWidget
                    config={{ widget: "scoreboards", position: "top-right" }}
                    view={view}
                    onActionClick={() => {}}
                    isOpen={isScoreboardOpen}
                    onToggle={setIsScoreboardOpen}
                    showTrigger={false}
                    className="relative flex flex-col items-end"
                    panelClassName="header-protrude w-72 sm:w-80 max-h-[70vh] overflow-y-auto rounded-xl shadow-floating bg-surface-1/95 backdrop-blur-md border border-surface-3 animate-in fade-in zoom-in-95 duration-200"
                  />
                </div>

                {/* Header-triggered Actions Panel */}
                <div className="header-panel-slot" data-open={isActionsOpen}>
                  <FloatingWidget
                    config={{ widget: "actions", position: "top-right" }}
                    view={view}
                    onActionClick={(action) => {
                      sfx.playClick();
                      if (playerId) sendActionIntent(gameId, playerId, action);
                    }}
                    actionsDisabled={Boolean(
                      view.seats?.find((s) => s.seatId === playerId)
                        ?.aiRuntime !== "none"
                    )}
                    isOpen={isActionsOpen}
                    onToggle={setIsActionsOpen}
                    showTrigger={false}
                    className="relative flex flex-col items-end"
                    panelClassName="header-protrude w-72 sm:w-80 max-h-[70vh] overflow-y-auto rounded-xl shadow-floating bg-surface-1/95 backdrop-blur-md border border-surface-3 animate-in fade-in zoom-in-95 duration-200"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {isRulesVisible && (
          <RulesOverlay
            rulesId={view?.rulesId ?? rulesId ?? ""}
            onClose={() => setRulesVisible(false)}
          />
        )}

        {isAboutVisible && (
          <AboutOverlay onClose={() => setAboutVisible(false)} />
        )}

        {gameId && (!view || !playerId) && isInitialGameLoad && (
          <LoadingOverlay message="Loading game..." />
        )}
      </div>

      {/* Toast Notifications */}
      <div
        className="fixed bottom-4 right-4 z-[1100] flex flex-col gap-2 items-end pointer-events-none"
        data-testid="status-message"
      >
        {!toastAutoCloseEnabled && activeToasts.length > 0 && (
          <button
            onClick={() => setActiveToasts([])}
            className="pointer-events-auto button-base button-secondary px-3 py-1.5 text-2xs uppercase tracking-wider shadow-lg bg-surface-1 border-surface-3 mb-1"
          >
            Clear all
          </button>
        )}
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
      </div>
    </main>
  );
}
