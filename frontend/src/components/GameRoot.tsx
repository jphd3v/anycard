import { useCallback, useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type {
  CardView,
  GameView,
  MoveIntent,
  PileLayout,
} from "../../../shared/schemas";
import {
  cardSetAtom,
  activeTransitionCardIdsAtom,
  gameIdAtom,
  gameViewAtom,
  isEvaluatingMoveAtom,
  freeDragEnabledAtom,
  autoRotateSeatAtom,
  pendingDragMoveAtom,
  pileSortSelectionsAtom,
} from "../state";
import { useToast } from "../hooks/useToast";
import { sendMoveIntent, sendActionIntent, sendClientIntent } from "../socket";
import { Card } from "./Card";
import { Pile } from "./Pile";
import { Zone } from "./Zone";
import { useGameLayout } from "../hooks/useGameLayout";
import { choosePileSorter, sortCardsForDisplay } from "../utils/pileSort";
import { useAiSponsor } from "../hooks/useAiSponsor";
import type { LayoutZone } from "../../../shared/schemas";
import { ScoreboardGrid } from "./ScoreboardGrid";
import { ActionsGrid } from "./ActionsGrid";
import { StartGameOverlay } from "./StartGameOverlay";
import {
  FloatingActionOverlay,
  type FloatingActionItem,
} from "./FloatingActionOverlay";
import { useCardSizing } from "../hooks/useCardSizing";
import { useCardSetAspectRatio } from "../hooks/useCardSetAspectRatio";
import { sfx } from "../utils/audio";
import { getRotationAngle, rotateLayout } from "../utils/layoutRotation";
import { useRef } from "react";

const MOBILE_COMPACT_HANDS_QUERY =
  "(pointer: coarse) and ((max-width: 900px) or (max-height: 520px))";
const COMPACT_RAIL_COLUMN_WEIGHT = 0.35;
const COMPACT_RAIL_COLUMN_MIN = "2.2rem";
const COMPACT_RAIL_ROW_WEIGHT = 0.2;
const COMPACT_RAIL_ROW_MIN = "1.5rem";

interface Props {
  view: GameView;
  playerId: string;
  showDetails?: boolean;
  disabled?: boolean;
  suppressStartOverlay?: boolean;
  holdStartOverlay?: boolean;
  isStartGameBusy?: boolean;
  onStartGame?: (isNextRound: boolean) => void;
  onSkipStartGameAnimations?: () => void;
  overrideStartOverlayIsNextRound?: boolean | null;
  onStartOverlayMinimizedChange?: (isMinimized: boolean) => void;
  highlightedWidget?: "actions" | "scoreboards" | null;
}

export function GameRoot({
  view,
  playerId,
  showDetails = false,
  disabled = false,
  suppressStartOverlay = false,
  holdStartOverlay = false,
  isStartGameBusy = false,
  onStartGame,
  onSkipStartGameAnimations,
  overrideStartOverlayIsNextRound = null,
  onStartOverlayMinimizedChange,
  highlightedWidget = null,
}: Props) {
  useAiSponsor();
  const gameId = useAtomValue(gameIdAtom);
  const setView = useSetAtom(gameViewAtom);
  const isEvaluatingMove = useAtomValue(isEvaluatingMoveAtom);
  const setIsEvaluating = useSetAtom(isEvaluatingMoveAtom);
  const setPendingDragMove = useSetAtom(pendingDragMoveAtom);
  const activeTransitionCardIds = useAtomValue(activeTransitionCardIdsAtom);
  const setActiveTransitionCardIds = useSetAtom(activeTransitionCardIdsAtom);
  const [activeCard, setActiveCard] = useState<CardView | null>(null);
  const [pileSortSelections, setPileSortSelections] = useAtom(
    pileSortSelectionsAtom
  );
  const rawLayout = useGameLayout(view.rulesId);
  const autoRotateSeat = useAtomValue(autoRotateSeatAtom);

  const [floatingActions, setFloatingActions] = useState<FloatingActionItem[]>(
    []
  );
  const zoneRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const lastActionKeyRef = useRef<string | null>(null);
  const dragCursorRef = useRef<string | null>(null);
  const activeTransitionCardIdsRef = useRef<Set<number> | null>(null);
  const [isCompactMobileView, setIsCompactMobileView] = useState(false);
  const [expandedOpponentHands, setExpandedOpponentHands] = useState<
    Set<string>
  >(new Set());
  const localSeatId = playerId;

  const layout = useMemo(() => {
    if (!rawLayout || !view || !playerId || !autoRotateSeat) return rawLayout;
    const angle = getRotationAngle(rawLayout, view, playerId);
    return rotateLayout(rawLayout, angle);
  }, [rawLayout, view, playerId, autoRotateSeat]);
  const zoneProxyPileIds = useMemo(() => {
    const map = new Map<string, string>();
    for (const zone of layout?.zones ?? []) {
      if (!zone?.id || !Array.isArray(zone.piles)) continue;
      if (zone.piles.length !== 1) continue;
      const pileId = zone.piles[0];
      if (typeof pileId !== "string" || pileId.length === 0) continue;
      map.set(`zone-proxy-${zone.id}`, pileId);
    }
    return map;
  }, [layout]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const media = window.matchMedia(MOBILE_COMPACT_HANDS_QUERY);
    const update = () => setIsCompactMobileView(media.matches);
    update();

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }

    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  const isCompactModeEnabled =
    isCompactMobileView && !!layout?.mobileCompactOpponentHands;

  const compactOpponentHandPileIds = useMemo(() => {
    const compactIds = new Set<string>();
    if (!isCompactModeEnabled) return compactIds;

    for (const pile of view.piles) {
      const isHandPile =
        layout?.pileStyles?.[pile.id]?.isHand ?? pile.id.includes("hand");
      const isOpponentHand =
        isHandPile &&
        typeof pile.ownerId === "string" &&
        pile.ownerId !== localSeatId;
      if (!isOpponentHand) continue;
      if (expandedOpponentHands.has(pile.id)) continue;
      compactIds.add(pile.id);
    }

    return compactIds;
  }, [
    expandedOpponentHands,
    isCompactModeEnabled,
    layout,
    localSeatId,
    view.piles,
  ]);

  const compactRailColumns = useMemo(() => {
    const cols = new Set<number>();
    if (!layout || !isCompactModeEnabled) return cols;

    for (const zone of layout.zones) {
      if ((zone.cell.colspan ?? 1) !== 1) continue;
      if (zone.piles.length !== 1) continue;
      const pileId = zone.piles[0];
      if (!compactOpponentHandPileIds.has(pileId)) continue;

      const pileLayout =
        layout.pileStyles?.[pileId]?.layout ??
        view.piles.find((p) => p.id === pileId)?.layout;
      if (pileLayout !== "vertical") continue;

      cols.add(zone.cell.col);
    }
    return cols;
  }, [compactOpponentHandPileIds, isCompactModeEnabled, layout, view.piles]);

  const compactRailRows = useMemo(() => {
    const rows = new Set<number>();
    if (!layout || !isCompactModeEnabled) return rows;

    for (const zone of layout.zones) {
      if ((zone.cell.rowspan ?? 1) !== 1) continue;
      if (zone.piles.length !== 1) continue;
      const pileId = zone.piles[0];
      if (!compactOpponentHandPileIds.has(pileId)) continue;

      const pileLayout =
        layout.pileStyles?.[pileId]?.layout ??
        view.piles.find((p) => p.id === pileId)?.layout;
      if (pileLayout !== "horizontal") continue;

      rows.add(zone.cell.row);
    }
    return rows;
  }, [compactOpponentHandPileIds, isCompactModeEnabled, layout, view.piles]);

  const columnWeights = useMemo(() => {
    if (!layout) return undefined;
    const weights = Array.from({ length: layout.cols }, () => 1);
    for (const col of compactRailColumns) {
      if (col >= 0 && col < weights.length) {
        weights[col] = COMPACT_RAIL_COLUMN_WEIGHT;
      }
    }
    return weights;
  }, [compactRailColumns, layout]);

  const rowWeights = useMemo(() => {
    if (!layout) return undefined;
    const weights = Array.from({ length: layout.rows }, () => 1);
    for (const row of compactRailRows) {
      if (row >= 0 && row < weights.length) {
        weights[row] = COMPACT_RAIL_ROW_WEIGHT;
      }
    }
    return weights;
  }, [compactRailRows, layout]);

  const gridTemplateColumns = useMemo(() => {
    if (!layout || !columnWeights) return "";
    return columnWeights
      .map((weight, colIdx) =>
        compactRailColumns.has(colIdx)
          ? `minmax(${COMPACT_RAIL_COLUMN_MIN}, ${weight}fr)`
          : `minmax(0, ${weight}fr)`
      )
      .join(" ");
  }, [columnWeights, compactRailColumns, layout]);

  const gridTemplateRows = useMemo(() => {
    if (!layout || !rowWeights) return "";
    return rowWeights
      .map((weight, rowIdx) =>
        compactRailRows.has(rowIdx)
          ? `minmax(${COMPACT_RAIL_ROW_MIN}, ${weight}fr)`
          : `minmax(0, ${weight}fr)`
      )
      .join(" ");
  }, [compactRailRows, layout, rowWeights]);

  useEffect(() => {
    setExpandedOpponentHands((prev) => {
      if (!isCompactModeEnabled) {
        return prev.size === 0 ? prev : new Set<string>();
      }

      let changed = false;
      const visiblePileIds = new Set(view.piles.map((pile) => pile.id));
      const next = new Set<string>();
      for (const pileId of prev) {
        if (visiblePileIds.has(pileId)) {
          next.add(pileId);
        } else {
          changed = true;
        }
      }
      if (!changed && next.size === prev.size) return prev;
      return next;
    });
  }, [isCompactModeEnabled, view.piles]);

  useEffect(() => {
    setExpandedOpponentHands(new Set<string>());
  }, [view.gameId]);

  const cardSetId = useAtomValue(cardSetAtom);
  const cardAspectRatio = useCardSetAspectRatio(cardSetId);
  const freeDragEnabled = useAtomValue(freeDragEnabledAtom);
  const mySeat = view.seats?.find((s) => s.seatId === localSeatId);
  const isAutomatedSeat = !!mySeat && mySeat.aiRuntime !== "none";
  const uiDisabled = disabled || isEvaluatingMove || isAutomatedSeat;
  const { boardRef, styleVars } = useCardSizing(
    layout,
    view,
    cardAspectRatio,
    compactOpponentHandPileIds,
    columnWeights,
    rowWeights
  );
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    })
  );

  const { showToast } = useToast();

  const [activeHighlight, setActiveHighlight] = useState<
    "actions" | "scoreboards" | null
  >(null);

  useEffect(() => {
    const lastAction = view.lastAction;
    if (!lastAction) return;

    // Use the unique ID from backend to trigger animations
    if (lastActionKeyRef.current === lastAction.id) return;
    lastActionKeyRef.current = lastAction.id;

    if (lastAction.action === "start-game") return;

    // Find the zone for this player, preferring the one containing their hand
    const handPileId = Object.entries(layout?.pileStyles ?? {}).find(
      ([pId, style]) =>
        style.isHand &&
        view.piles.find((p) => p.id === pId)?.ownerId === lastAction.playerId
    )?.[0];

    const zoneId = layout?.zones.find((z) =>
      handPileId
        ? z.piles.includes(handPileId)
        : z.piles.some(
            (pId) =>
              view.piles.find((p) => p.id === pId)?.ownerId ===
              lastAction.playerId
          )
    )?.id;

    if (zoneId && zoneRefs.current[zoneId]) {
      const rect = zoneRefs.current[zoneId]!.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;

      const newItem: FloatingActionItem = {
        id: Math.random().toString(36).substring(2, 9),
        label: lastAction.label ?? lastAction.action,
        x,
        y,
      };

      setFloatingActions((prev) => [...prev, newItem]);
    }
  }, [view.lastAction, layout, view.piles]);

  const handleRemoveFloatingAction = useCallback((id: string) => {
    setFloatingActions((prev) => prev.filter((a) => a.id !== id));
  }, []);

  useEffect(() => {
    if (highlightedWidget) {
      setActiveHighlight(highlightedWidget);
    }
  }, [highlightedWidget]);

  useEffect(() => {
    if (activeHighlight) {
      const timer = setTimeout(() => setActiveHighlight(null), 1200);
      return () => clearTimeout(timer);
    }
  }, [activeHighlight]);

  useEffect(() => {
    activeTransitionCardIdsRef.current = activeTransitionCardIds;
  }, [activeTransitionCardIds]);

  useEffect(() => {
    return () => {
      if (dragCursorRef.current !== null) {
        document.body.style.cursor = dragCursorRef.current;
        dragCursorRef.current = null;
      }
    };
  }, []);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      if (isAutomatedSeat) return;
      const card = event.active.data.current?.card as CardView | undefined;
      if (card) {
        setActiveCard(card);
      }
      if (dragCursorRef.current === null) {
        dragCursorRef.current = document.body.style.cursor;
      }
      document.body.style.cursor = "grabbing";
    },
    [isAutomatedSeat]
  );

  const handleActionClick = useCallback(
    (actionName: string) => {
      if (isAutomatedSeat) return;
      const matchingIntent = view.legalIntents?.find(
        (intent) => intent.type === "action" && intent.action === actionName
      );
      if (view.legalIntents && !matchingIntent) {
        showToast("This action is not available right now.", "error", "app");
        return;
      }
      sfx.playClick();
      if (matchingIntent && matchingIntent.type === "action") {
        sendClientIntent(matchingIntent);
        return;
      }
      sendActionIntent(gameId, playerId, actionName);
    },
    [gameId, isAutomatedSeat, playerId, showToast, view.legalIntents]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (isAutomatedSeat) return;
      if (dragCursorRef.current !== null) {
        document.body.style.cursor = dragCursorRef.current;
        dragCursorRef.current = null;
      }
      setActiveCard(null);
      const { active, over } = event;

      if (!active || !over || !playerId) return;

      const fromPileId = active.data.current?.pileId as string | undefined;
      const cardId = active.data.current?.cardId as number | undefined;

      // Resolve the target pile ID from the 'over' element.
      // It might be a direct pile ID or a 'zone-proxy' data payload.
      const overData = over.data.current;
      let toPileId =
        (overData?.pileId as string | undefined) ??
        (typeof over.id === "string" ? over.id : undefined);
      if (toPileId && zoneProxyPileIds.has(toPileId)) {
        toPileId = zoneProxyPileIds.get(toPileId);
      }

      // 1. Check if this is a sortable reorder within the same pile
      const isSortableDrag =
        typeof active.id === "string" && active.id.startsWith("sortable-");
      const isSamePile = fromPileId === toPileId;

      if (isSamePile && !isSortableDrag) {
        // Regular drag within same pile (not sortable) - stop
        return;
      }

      // 2. STRICT FIX: If it's not the current player's turn, STOP immediately.
      if (
        !freeDragEnabled &&
        view.currentPlayer &&
        view.currentPlayer !== playerId
      ) {
        showToast("It's not your turn", "error", "app");
        return;
      }

      // 3. validation
      if (!fromPileId || !toPileId || typeof cardId !== "number") {
        return;
      }

      // 4. Handle sortable reordering within the same pile
      if (isSortableDrag && isSamePile) {
        const pile = view.piles.find((p) => p.id === fromPileId);
        if (!pile) return;

        const oldIndex = pile.cards.findIndex((c) => c.id === cardId);
        if (oldIndex === -1) return;

        // Extract target index from the over element
        let newIndex = oldIndex;
        if (typeof over.id === "string" && over.id.startsWith("sortable-")) {
          const overCardId = over.data.current?.cardId as number | undefined;
          if (typeof overCardId === "number") {
            newIndex = pile.cards.findIndex((c) => c.id === overCardId);
          }
        }

        if (newIndex === -1 || oldIndex === newIndex) return;

        // Optimistically update UI
        setView((draft) => {
          if (!draft) return;
          const draftPile = draft.piles.find((p) => p.id === fromPileId);
          if (!draftPile) return;

          const [card] = draftPile.cards.splice(oldIndex, 1);
          draftPile.cards.splice(newIndex, 0, card);
        });

        // Send reorder intent with targetIndex
        sendMoveIntent(
          gameId,
          playerId,
          fromPileId,
          toPileId,
          cardId,
          newIndex
        );
        setIsEvaluating(true);
        return;
      }

      const matchingIntent = view.legalIntents?.find(
        (intent): intent is MoveIntent =>
          intent.type === "move" &&
          intent.fromPileId === fromPileId &&
          intent.toPileId === toPileId &&
          (intent.cardId === cardId ||
            intent.cardIds?.includes(cardId) === true)
      );

      setPendingDragMove({
        gameId,
        playerId,
        fromPileId,
        toPileId,
        cardId,
      });
      setView((draft) => {
        if (!draft) return;
        const sourcePile = draft.piles.find((p) => p.id === fromPileId);
        const targetPile = draft.piles.find((p) => p.id === toPileId);

        if (sourcePile && targetPile) {
          const cardIdsToMove = matchingIntent?.cardIds ?? [cardId];
          for (const cid of cardIdsToMove) {
            const cardIndex = sourcePile.cards.findIndex((c) => c.id === cid);
            if (cardIndex !== -1) {
              const [card] = sourcePile.cards.splice(cardIndex, 1);
              targetPile.cards.push(card);
            }
          }
        }
      });

      if (matchingIntent) {
        sendClientIntent(matchingIntent);
      } else {
        sendMoveIntent(gameId, playerId, fromPileId, toPileId, cardId);
      }
      setIsEvaluating(true);
    },
    [
      gameId,
      playerId,
      setIsEvaluating,
      setView,
      showToast,
      view.currentPlayer,
      view.legalIntents,
      view.piles,
      freeDragEnabled,
      isAutomatedSeat,
      zoneProxyPileIds,
      setPendingDragMove,
    ]
  );

  const handleDragCancel = useCallback(() => {
    sfx.playCardLower();
    if (dragCursorRef.current !== null) {
      document.body.style.cursor = dragCursorRef.current;
      dragCursorRef.current = null;
    }
    setActiveCard(null);
  }, []);

  useEffect(() => {
    if (!layout?.pileStyles) {
      setPileSortSelections({});
      return;
    }

    setPileSortSelections((prev) => {
      const next: Record<string, string> = {};
      for (const [pileId, style] of Object.entries(layout.pileStyles ?? {})) {
        const sort = style.sort;
        const optionIds = sort?.options?.map((o) => o.id) ?? [];
        if (optionIds.length === 0) continue;

        const fallback =
          sort?.default && optionIds.includes(sort.default)
            ? sort.default
            : optionIds[0];
        const current = prev[pileId];
        next[pileId] =
          current && optionIds.includes(current) ? current : fallback;
      }
      return next;
    });
  }, [layout, view.rulesId, setPileSortSelections]);

  const normalizePileLayout = (val?: string) =>
    ["horizontal", "vertical", "complete", "spread"].includes(val || "")
      ? (val as PileLayout)
      : undefined;

  const toggleOpponentHandCompact = useCallback(
    (pileId: string) => {
      if (!isCompactModeEnabled) return;
      setExpandedOpponentHands((prev) => {
        const next = new Set(prev);
        if (next.has(pileId)) {
          next.delete(pileId);
        } else {
          next.add(pileId);
        }
        return next;
      });
    },
    [isCompactModeEnabled]
  );

  const renderPileFromLayout = (pileId: string, zone?: LayoutZone) => {
    const basePile = view.piles.find((p) => p.id === pileId);
    if (!basePile) return null;

    const override = layout?.pileStyles?.[pileId];
    const { sort, ...restOverride } = override ?? {};
    const normalizedLayout =
      normalizePileLayout(basePile.layout) ??
      normalizePileLayout(override?.layout) ??
      "complete";
    const optionIds = sort?.options?.map((o) => o.id) ?? [];
    const fallbackSortId =
      sort && sort.default && optionIds.includes(sort.default)
        ? sort.default
        : optionIds[0];

    const selectedSortId =
      sort &&
      pileSortSelections[pileId] &&
      optionIds.includes(pileSortSelections[pileId])
        ? pileSortSelections[pileId]
        : fallbackSortId;

    const { sorter, resolvedId } = choosePileSorter(sort, selectedSortId);
    const sortedCards = sortCardsForDisplay(
      basePile.cards,
      sorter,
      normalizedLayout
    );

    const pileToRender = {
      ...basePile,
      ...restOverride,
      layout: normalizedLayout,
      cards: sortedCards,
    };

    const isSinglePileZone = zone?.piles.length === 1;
    const displayName = isSinglePileZone
      ? (pileToRender.label ?? zone?.label ?? pileToRender.id)
      : undefined;

    const allowViewerToggle = sort?.allowViewerToggle ?? true;

    // Read allowReorder from rules-derived pile view
    // Only enable when there are at least 2 cards to reorder
    const allowReorderFromRules = pileToRender.allowReorder ?? false;
    const allowReorder =
      allowReorderFromRules && pileToRender.cards.length >= 2;
    const isHandPile = pileToRender.isHand ?? pileId.includes("hand");
    const isOpponentHandPile =
      isHandPile &&
      typeof pileToRender.ownerId === "string" &&
      pileToRender.ownerId !== localSeatId;
    const canUseCompactMode = isCompactModeEnabled && isOpponentHandPile;
    const isCompact =
      canUseCompactMode && compactOpponentHandPileIds.has(pileId);

    return (
      <Pile
        key={pileId}
        pile={pileToRender}
        className={override?.className}
        disabled={uiDisabled}
        displayName={displayName}
        hideTitle={override?.hideTitle}
        showDetails={override?.showDetails ?? showDetails}
        sortOptions={sort?.options}
        selectedSortId={resolvedId}
        allowViewerToggle={allowViewerToggle}
        allowReorder={allowReorder}
        isProxyTarget={isSinglePileZone}
        compact={isCompact}
        onToggleCompact={
          canUseCompactMode
            ? () => toggleOpponentHandCompact(pileId)
            : undefined
        }
        onChangeSort={
          allowViewerToggle && sort?.options?.length
            ? (id) => {
                if (!sort.options?.some((opt) => opt.id === id)) return;
                if (id === resolvedId) return;
                if (typeof document === "undefined") {
                  setPileSortSelections((prev) => ({ ...prev, [pileId]: id }));
                  return;
                }

                const startViewTransition = (
                  document as Document & {
                    startViewTransition?: (
                      callback: () => void
                    ) => { finished?: Promise<unknown> } | void;
                  }
                ).startViewTransition?.bind(document);

                const canAnimateSort =
                  !!startViewTransition &&
                  document.visibilityState === "visible" &&
                  !activeTransitionCardIds;

                if (!canAnimateSort) {
                  setPileSortSelections((prev) => ({ ...prev, [pileId]: id }));
                  return;
                }

                const transitionCardIds = new Set(
                  sortedCards.map((card) => card.id)
                );

                flushSync(() => {
                  setActiveTransitionCardIds(transitionCardIds);
                });
                activeTransitionCardIdsRef.current = transitionCardIds;

                let transition: { finished?: Promise<unknown> } | void;
                try {
                  transition = startViewTransition(() => {
                    flushSync(() => {
                      setPileSortSelections((prev) => ({
                        ...prev,
                        [pileId]: id,
                      }));
                    });
                  });
                } catch {
                  setActiveTransitionCardIds(null);
                  activeTransitionCardIdsRef.current = null;
                  setPileSortSelections((prev) => ({ ...prev, [pileId]: id }));
                  return;
                }

                const finalizeTransition = () => {
                  if (
                    activeTransitionCardIdsRef.current === transitionCardIds
                  ) {
                    setActiveTransitionCardIds(null);
                    activeTransitionCardIdsRef.current = null;
                  }
                };

                if (transition && transition.finished) {
                  transition.finished.then(finalizeTransition).catch(() => {
                    finalizeTransition();
                  });
                } else {
                  finalizeTransition();
                }
              }
            : undefined
        }
      />
    );
  };

  const renderZoneContent = (zone: LayoutZone) => {
    if (zone.widget === "actions" && view.actions) {
      return (
        <ActionsGrid
          actions={view.actions}
          onActionClick={handleActionClick}
          disabled={uiDisabled}
          orientation={zone.actionOrientation}
        />
      );
    }
    if (zone.widget === "scoreboards" && view.scoreboards) {
      return (
        <div
          className="flex flex-col w-full h-full justify-center"
          style={{ gap: "var(--zone-gap, 0.5rem)" }}
        >
          {view.scoreboards.map((sb) => (
            <ScoreboardGrid key={sb.id} scoreboard={sb} />
          ))}
        </div>
      );
    }

    return (
      <div
        className="w-full h-full flex flex-wrap items-start justify-start overflow-hidden"
        style={{ gap: "var(--pile-gap, 0.5rem)" }}
      >
        {zone.piles.map((pileId) => renderPileFromLayout(pileId, zone))}
      </div>
    );
  };

  const renderLayout = () => {
    if (!layout) {
      return (
        <div className="w-full h-full flex items-center justify-center p-8 text-ink-muted">
          Loading Layout...
        </div>
      );
    }

    return (
      <div
        className="w-full h-full flex items-center justify-center"
        style={{ padding: "var(--table-padding)" }}
      >
        <div
          ref={boardRef}
          className="w-full h-full grid"
          style={{
            ...styleVars,
            // CSS GRID MAGIC:
            // 1fr = distribute space equally
            // minmax(0, ...) = allow shrinking below content size (prevents overflow)
            gridTemplateRows:
              gridTemplateRows || `repeat(${layout.rows}, minmax(0, 1fr))`,
            gridTemplateColumns:
              gridTemplateColumns || `repeat(${layout.cols}, minmax(0, 1fr))`,
            gap: "var(--zone-gap)",

            // Constrain to viewport so it never scrolls
            maxHeight: "100%",
            maxWidth: "100%",
          }}
        >
          {layout.zones.map((zone) => {
            const { row, col, rowspan = 1, colspan = 1 } = zone.cell;

            // Check if this zone holds a widget
            const isWidgetZone =
              zone.widget === "actions" || zone.widget === "scoreboards";
            const isHighlighted = activeHighlight === zone.widget;

            return (
              <div
                key={zone.id}
                ref={(el) => (zoneRefs.current[zone.id] = el)}
                className={`relative min-h-0 min-w-0 transition-all duration-700 rounded-xl ${
                  isHighlighted
                    ? "ring-2 ring-primary/50 shadow-[0_10px_30px_rgba(0,0,0,0.2)] scale-[1.03] z-20"
                    : ""
                }`}
                style={{
                  gridRow: `${row + 1} / span ${rowspan}`,
                  gridColumn: `${col + 1} / span ${colspan}`,
                }}
              >
                {isWidgetZone ? (
                  <div className="w-full h-full flex items-center justify-center">
                    {renderZoneContent(zone)}
                  </div>
                ) : (
                  <Zone
                    zone={zone}
                    renderPile={renderPileFromLayout}
                    disabled={uiDisabled}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <section className="w-full h-full">
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {renderLayout()}
        <DragOverlay dropAnimation={null} style={styleVars}>
          {activeCard ? (
            <Card
              card={activeCard}
              className="pointer-events-none shadow-floating"
              // No more transform scale here, CSS vars handle size
            />
          ) : null}
        </DragOverlay>
        <StartGameOverlay
          view={view}
          playerId={playerId}
          suppress={suppressStartOverlay}
          holdOpen={holdStartOverlay}
          isStartGameBusy={isStartGameBusy}
          onStartGame={onStartGame}
          onSkipAnimations={onSkipStartGameAnimations}
          overrideIsNextRound={overrideStartOverlayIsNextRound}
          onMinimizedChange={onStartOverlayMinimizedChange}
        />
        <FloatingActionOverlay
          actions={floatingActions}
          onComplete={handleRemoveFloatingAction}
          viewTransitionName="action-overlay"
        />
      </DndContext>
    </section>
  );
}
