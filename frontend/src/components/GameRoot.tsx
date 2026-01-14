import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useAtomValue, useSetAtom } from "jotai";
import type { CardView, GameView, PileLayout } from "../../../shared/schemas";
import {
  cardSetAtom,
  gameIdAtom,
  gameViewAtom,
  isEvaluatingMoveAtom,
  statusMessageAtom,
  freeDragEnabledAtom,
  autoRotateSeatAtom,
} from "../state";
import { sendMoveIntent, sendActionIntent } from "../socket";
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

interface Props {
  view: GameView;
  playerId: string;
  showDetails?: boolean;
  disabled?: boolean;
  suppressStartOverlay?: boolean;
  highlightedWidget?: "actions" | "scoreboards" | null;
}

export function GameRoot({
  view,
  playerId,
  showDetails = false,
  disabled = false,
  suppressStartOverlay = false,
  highlightedWidget = null,
}: Props) {
  useAiSponsor();
  const gameId = useAtomValue(gameIdAtom);
  const setView = useSetAtom(gameViewAtom);
  const isEvaluatingMove = useAtomValue(isEvaluatingMoveAtom);
  const setIsEvaluating = useSetAtom(isEvaluatingMoveAtom);
  const [activeCard, setActiveCard] = useState<CardView | null>(null);
  const [pileSortSelections, setPileSortSelections] = useState<
    Record<string, string>
  >({});
  const rawLayout = useGameLayout(view.rulesId);
  const autoRotateSeat = useAtomValue(autoRotateSeatAtom);

  const [floatingActions, setFloatingActions] = useState<FloatingActionItem[]>(
    []
  );
  const zoneRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const lastActionKeyRef = useRef<string | null>(null);

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

  const cardSetId = useAtomValue(cardSetAtom);
  const cardAspectRatio = useCardSetAspectRatio(cardSetId);
  const freeDragEnabled = useAtomValue(freeDragEnabledAtom);
  const mySeat = view.seats?.find((s) => s.seatId === playerId);
  const isAutomatedSeat = !!mySeat && mySeat.aiRuntime !== "none";
  const uiDisabled = disabled || isEvaluatingMove || isAutomatedSeat;
  const { boardRef, styleVars } = useCardSizing(layout, view, cardAspectRatio);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    })
  );

  const addStatusMessage = useSetAtom(statusMessageAtom);

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

    // Find the zone for this player
    const zoneId = layout?.zones.find((z) =>
      z.piles.some(
        (pId) =>
          view.piles.find((p) => p.id === pId)?.ownerId === lastAction.playerId
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

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      if (isAutomatedSeat) return;
      const card = event.active.data.current?.card as CardView | undefined;
      if (card) {
        setActiveCard(card);
      }
    },
    [isAutomatedSeat]
  );

  const handleActionClick = useCallback(
    (actionName: string) => {
      if (isAutomatedSeat) return;
      sfx.playClick();
      sendActionIntent(gameId, playerId, actionName);
    },
    [gameId, isAutomatedSeat, playerId]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (isAutomatedSeat) return;
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

      // 1. STRICT FIX: If source and target are the same, STOP immediately.
      if (fromPileId === toPileId) {
        return;
      }

      // 2. STRICT FIX: If it's not the current player's turn, STOP immediately.
      if (
        !freeDragEnabled &&
        view.currentPlayer &&
        view.currentPlayer !== playerId
      ) {
        // Show "not your turn" status message
        const id = Date.now() + Math.random();
        const statusMessage = {
          tone: "error" as const,
          message: "It's not your turn",
          source: "app" as const,
          id,
        };
        // Prepend the new message (similar to App.tsx logic)
        addStatusMessage((prev) => [statusMessage, ...prev]);

        // Auto-dismiss to match App.tsx behavior
        setTimeout(() => {
          addStatusMessage((prev) => prev.filter((m) => m.id !== id));
        }, 3750);

        return;
      }

      // 3. validation
      if (!fromPileId || !toPileId || typeof cardId !== "number") {
        return;
      }

      setView((draft) => {
        if (!draft) return;
        const sourcePile = draft.piles.find((p) => p.id === fromPileId);
        const targetPile = draft.piles.find((p) => p.id === toPileId);

        if (sourcePile && targetPile) {
          const cardIndex = sourcePile.cards.findIndex((c) => c.id === cardId);
          if (cardIndex !== -1) {
            const [card] = sourcePile.cards.splice(cardIndex, 1);
            targetPile.cards.push(card);
          }
        }
      });
      sendMoveIntent(gameId, playerId, fromPileId, toPileId, cardId);
      setIsEvaluating(true);
    },
    [
      gameId,
      playerId,
      setIsEvaluating,
      setView,
      addStatusMessage,
      view.currentPlayer,
      freeDragEnabled,
      isAutomatedSeat,
      zoneProxyPileIds,
    ]
  );

  const handleDragCancel = useCallback(() => {
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
  }, [layout, view.rulesId]);

  const normalizePileLayout = (val?: string) =>
    ["horizontal", "vertical", "complete", "spread"].includes(val || "")
      ? (val as PileLayout)
      : undefined;

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

    return (
      <Pile
        key={pileId}
        pile={pileToRender}
        className={override?.className}
        disabled={uiDisabled}
        displayName={displayName}
        showDetails={override?.showDetails ?? showDetails}
        sortOptions={sort?.options}
        selectedSortId={resolvedId}
        allowViewerToggle={allowViewerToggle}
        isProxyTarget={isSinglePileZone}
        onChangeSort={
          allowViewerToggle && sort?.options?.length
            ? (id) => {
                if (!sort.options?.some((opt) => opt.id === id)) return;
                setPileSortSelections((prev) => ({ ...prev, [pileId]: id }));
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
        <div className="flex flex-col gap-4 w-full h-full justify-center">
          {view.scoreboards.map((sb) => (
            <ScoreboardGrid key={sb.id} scoreboard={sb} />
          ))}
        </div>
      );
    }

    return (
      <div className="w-full h-full flex flex-wrap items-center justify-center gap-4 overflow-hidden">
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
            gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
            gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
            gap: "var(--pile-gap)",

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
        />
        <FloatingActionOverlay
          actions={floatingActions}
          onComplete={handleRemoveFloatingAction}
        />
      </DndContext>
    </section>
  );
}
