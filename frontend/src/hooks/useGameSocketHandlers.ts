import { useEffect } from "react";
import { flushSync } from "react-dom";
import type { MutableRefObject } from "react";
import type {
  CardView,
  GameLayout,
  GameView,
  SeatStatus,
  ViewEventPayload,
} from "../../../shared/schemas";
import type { ParsedRoute } from "../utils/appRouting";
import type {
  AiLogEntry,
  FatalErrorState,
  PendingDragMove,
  StatusMessage,
} from "../state";
import { setupSocketHandlers } from "../socket";
import { sfx } from "../utils/audio";
import {
  applyMoveRevealToView,
  applyOptimisticDragMove,
  applyViewEventToView,
  collectDuplicateCardIds,
  getCardViewsForIds,
} from "../utils/gameViewEvents";
import {
  didPileOrderChange,
  shouldAnimatePileReflow,
  sortViewPiles,
  type PileTransitionConfig,
} from "../utils/pileTransitions";
import {
  getCardFlipDurationMs,
  getDynamicDuration,
} from "../utils/animationTimings";
import { hasGameDealt } from "../utils/gameViewState";

type AnnounceViewEvent = Extract<ViewEventPayload, { type: "announce" }>;

type RouteError =
  | null
  | { kind: "GAME_NOT_FOUND"; gameId?: string; rulesId?: string }
  | {
      kind: "UNKNOWN_ERROR";
      gameId?: string;
      rulesId?: string;
      message?: string;
    };

type LastJoin = {
  gameId: string;
  rulesId: string;
  playerId: string;
  role: "player" | "spectator";
  isGodMode?: boolean;
  roomType?: "demo" | "public" | "private";
};

type SetState<T> = (update: T | ((prev: T) => T)) => void;

type GameSocketHandlersOptions = {
  getPileSortSelections: () => Record<string, string>;
  stateQueueRef: MutableRefObject<GameView[]>;
  isProcessingRef: MutableRefObject<boolean>;
  stateGenerationRef: MutableRefObject<number>;
  lastAuthoritativeViewRef: MutableRefObject<GameView | null>;
  pendingDragMoveRef: MutableRefObject<PendingDragMove | null>;
  skipAnimationsRef: MutableRefObject<boolean>;
  skipAnimationWaitersRef: MutableRefObject<Set<() => void>>;
  activeViewTransitionRef: MutableRefObject<{
    skipTransition?: () => void;
  } | null>;
  startGameActionIdRef: MutableRefObject<string | null>;
  gameLayoutRef: MutableRefObject<GameLayout | null>;
  pileTransitionConfigRef: MutableRefObject<PileTransitionConfig>;
  visiblePileIdsRef: MutableRefObject<Set<string>>;
  clearHighlightsTimerRef: MutableRefObject<number | null>;
  isAnyOverlayOpenRef: MutableRefObject<boolean>;
  playerId: string | null;
  routeError: RouteError;
  initialRoute: ParsedRoute | null;
  gameIdRef: MutableRefObject<string>;
  defaultRouteRef: MutableRefObject<string | null>;
  lastJoinRef: MutableRefObject<LastJoin | null>;
  setStartingGameType: SetState<string | null>;
  setGameType: SetState<string | null>;
  setGameId: SetState<string>;
  setSeats: SetState<SeatStatus[]>;
  setRoomSeed: SetState<string | null>;
  setIsInitialGameLoad: SetState<boolean>;
  setIsEvaluating: SetState<boolean>;
  setActiveTransitionCardIds: SetState<Set<number> | null>;
  setHeaderTransitionCards: SetState<CardView[]>;
  setPendingDragMove: SetState<PendingDragMove | null>;
  setFatalError: SetState<FatalErrorState | null>;
  setIsStartGameAnimating: SetState<boolean>;
  setStartGamePendingKind: SetState<"first" | "next" | null>;
  setView: SetState<GameView | null>;
  setAiLog: SetState<AiLogEntry[]>;
  setJoinedGameId: SetState<string | null>;
  setPlayerId: SetState<string | null>;
  setIsCreator: SetState<boolean>;
  setRouteError: SetState<RouteError>;
  setHighlightedActionId: SetState<string | null>;
  setHighlightedActionLabel: SetState<string | null>;
  setHighlightedScoreboardCells: SetState<Record<string, string[]>>;
  showStatus: (message: Omit<StatusMessage, "id">) => void;
  queueAnnouncement: (event: AnnounceViewEvent) => void;
  clearStartGamePending: (options?: { keepKind?: boolean }) => void;
  clearSkipStartGameAnimations: () => void;
  waitMsOrSkip: (durationMs: number) => Promise<void>;
  attemptRejoin: () => void;
  removeRecentGame: (gameId: string) => void;
};

const MAX_TRANSITION_CARDS_PER_PILE = 24;
const MAX_TRANSITION_CARDS = 80;
const MAX_HEADER_TRANSITION_CARDS = 8;

export function useGameSocketHandlers({
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
}: GameSocketHandlersOptions) {
  useEffect(() => {
    const processStatePayload = async (
      payload: GameView,
      generation: number,
      duration: number = 1000,
      remainingInQueue: number = 0
    ) => {
      const pileSortSelections = getPileSortSelections();

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
      const isStartGameAction = lastAction?.action === "start-game";
      const finishStartGameAnimation = () => {
        if (
          isStartGameAction &&
          startGameActionIdRef.current === lastAction?.id
        ) {
          setIsStartGameAnimating(false);
          setStartGamePendingKind(null);
          clearSkipStartGameAnimations();
        }
      };

      if (isStartGameAction) {
        clearStartGamePending({ keepKind: true });
        setIsStartGameAnimating(true);
        startGameActionIdRef.current = lastAction?.id ?? null;
      }

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

      const applyImmediateView = (
        eventsToQueue: ViewEventPayload[] = animationEvents
      ) => {
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
        activeViewTransitionRef.current = null;
        if (eventsToQueue.length > 0) {
          queueAnnouncements(eventsToQueue);
        }
        finishStartGameAnimation();
        if (skipAnimationsRef.current) {
          clearSkipStartGameAnimations();
        }
      };

      const skipToFinal = (fromIndex: number) => {
        applyImmediateView(animationEvents.slice(fromIndex));
      };

      if (skipAnimationsRef.current) {
        applyImmediateView();
        return;
      }

      // Skip View Transitions when any overlay is open to prevent click interception
      const canAnimate =
        !!startViewTransition &&
        document.visibilityState === "visible" &&
        !skipAnimationsRef.current &&
        !isAnyOverlayOpenRef.current;

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
        applyImmediateView();
        return;
      }

      // Avoid animating during setup/deal phases unless we just started dealing
      if (!hasGameDealt(prevView) && !isStartGameAction) {
        applyImmediateView();
        return;
      }

      // Animate by applying engine events on top of the previous view.
      // Each state change runs inside a view transition so CSS View Transitions
      // can animate DOM diffs between steps.
      let workingView = prevView;
      const flipPauseMs = duration > 0 ? getCardFlipDurationMs() : 0;
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
        if (skipAnimationsRef.current) {
          skipToFinal(index);
          return;
        }
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

        const uniqueCardIds = Array.from(new Set(event.cardIds));
        const movingIds = new Set<number>(uniqueCardIds);
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
            ? getCardViewsForIds(nextWorkingView, uniqueCardIds)
            : [];
        const exitCardsRaw =
          fromVisible && !toVisible
            ? getCardViewsForIds(nextWorkingView, uniqueCardIds)
            : [];
        const entryCards =
          entryCardsRaw.length > MAX_HEADER_TRANSITION_CARDS
            ? []
            : entryCardsRaw;
        const exitCards =
          exitCardsRaw.length > MAX_HEADER_TRANSITION_CARDS ? [] : exitCardsRaw;
        const hasHeaderAnchors = entryCards.length > 0 || exitCards.length > 0;
        const duplicateTransitionIds = new Set<number>();
        for (const id of collectDuplicateCardIds(
          workingView,
          entryCards,
          visiblePileIds
        )) {
          duplicateTransitionIds.add(id);
        }
        for (const id of collectDuplicateCardIds(
          nextWorkingView,
          exitCards,
          visiblePileIds
        )) {
          duplicateTransitionIds.add(id);
        }

        let transitionIds = new Set<number>();
        flushSync(() => {
          transitionIds = new Set<number>(movingIds);
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
          if (duplicateTransitionIds.size > 0) {
            const filtered = new Set<number>();
            for (const id of transitionIds) {
              if (!duplicateTransitionIds.has(id)) {
                filtered.add(id);
              }
            }
            transitionIds = filtered;
          }

          setActiveTransitionCardIds(transitionIds);
          setHeaderTransitionCards(entryCards);
        });

        const applyWorkingView = () => {
          setHeaderTransitionCards(exitCards);
          workingView = nextWorkingView;
          lastAuthoritativeViewRef.current = workingView;
          setView(workingView);
        };

        if (!startViewTransition) {
          flushSync(() => {
            setActiveTransitionCardIds(null);
            setHeaderTransitionCards([]);
            workingView = nextWorkingView;
            lastAuthoritativeViewRef.current = workingView;
            setView(workingView);
          });
          continue;
        }

        let transition: { finished?: Promise<unknown> } | void;
        try {
          transition = startViewTransition(() => {
            flushSync(applyWorkingView);
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

        activeViewTransitionRef.current =
          transition &&
          typeof (transition as { skipTransition?: () => void })
            .skipTransition === "function"
            ? (transition as { skipTransition?: () => void })
            : null;

        // Chain transitions if the browser provides a finished promise
        try {
          await (transition as { finished?: Promise<void> })?.finished;
        } catch {
          // Ignore transition errors; continue to next step
        }
        activeViewTransitionRef.current = null;
        if (skipAnimationsRef.current) {
          skipToFinal(index + 1);
          return;
        }

        flushSync(() => {
          setActiveTransitionCardIds(null);
        });
        await waitMsOrSkip(0);
        if (skipAnimationsRef.current) {
          skipToFinal(index + 1);
          return;
        }

        const revealViewRaw = applyMoveRevealToView(
          workingView,
          event,
          nextView
        );
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
            await waitMsOrSkip(flipPauseMs);
            if (skipAnimationsRef.current) {
              skipToFinal(index + 1);
              return;
            }
          } else {
            pendingFlipPause = true;
          }
        }
      }

      // Final sanity step: ensure we end up at the authoritative server view
      if (pendingFlipPause && flipPauseMs > 0) {
        await waitMsOrSkip(flipPauseMs);
        if (skipAnimationsRef.current) {
          applyImmediateView([]);
          return;
        }
      }
      if (skipAnimationsRef.current) {
        applyImmediateView([]);
        return;
      }
      if (!startViewTransition) {
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
      } else {
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

          activeViewTransitionRef.current =
            finalTransition &&
            typeof (finalTransition as { skipTransition?: () => void })
              .skipTransition === "function"
              ? (finalTransition as { skipTransition?: () => void })
              : null;

          try {
            await (finalTransition as { finished?: Promise<void> })?.finished;
          } catch {
            // Ignore
          }
          activeViewTransitionRef.current = null;
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
      }

      scheduleClearHighlights();
      finishStartGameAnimation();
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
        const baseDuration = getDynamicDuration(
          remainingInQueue,
          becomesMyTurn
        );
        const duration = skipAnimationsRef.current ? 0 : baseDuration;

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
          clearStartGamePending();
          clearSkipStartGameAnimations();
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
        const isLobbyRoute =
          typeof window !== "undefined" && window.location.pathname === "/";
        const shouldAdoptGameId =
          currentGameId === "" &&
          payload.gameId !== "" &&
          !isLobbyRoute &&
          !routeError;
        if (payload.gameId === currentGameId || shouldAdoptGameId) {
          setSeats(payload.seats);
          setRoomSeed(payload.seed ?? null);
          setIsInitialGameLoad(false);
          if (shouldAdoptGameId) {
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
    clearSkipStartGameAnimations,
    clearStartGamePending,
    defaultRouteRef,
    gameIdRef,
    getPileSortSelections,
    initialRoute,
    isProcessingRef,
    lastAuthoritativeViewRef,
    lastJoinRef,
    pendingDragMoveRef,
    playerId,
    queueAnnouncement,
    removeRecentGame,
    routeError,
    setActiveTransitionCardIds,
    setAiLog,
    setFatalError,
    setGameId,
    setGameType,
    setHeaderTransitionCards,
    setHighlightedActionId,
    setHighlightedActionLabel,
    setHighlightedScoreboardCells,
    setIsCreator,
    setIsEvaluating,
    setIsInitialGameLoad,
    setIsStartGameAnimating,
    setJoinedGameId,
    setPendingDragMove,
    setPlayerId,
    setRoomSeed,
    setRouteError,
    setSeats,
    setStartingGameType,
    setStartGamePendingKind,
    setView,
    showStatus,
    stateGenerationRef,
    stateQueueRef,
    waitMsOrSkip,
    skipAnimationsRef,
    skipAnimationWaitersRef,
    activeViewTransitionRef,
    startGameActionIdRef,
    gameLayoutRef,
    pileTransitionConfigRef,
    visiblePileIdsRef,
    clearHighlightsTimerRef,
    isAnyOverlayOpenRef,
  ]); // Removed gameId from dependencies to prevent listener teardown race
}
