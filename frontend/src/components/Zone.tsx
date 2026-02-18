import { useDroppable, useDndContext } from "@dnd-kit/core";
import { useAtom, useAtomValue } from "jotai";
import { useState } from "react";
import type { LayoutZone } from "../../../shared/schemas";
import {
  freeDragEnabledAtom,
  gameViewAtom,
  moveTypeAtom,
  playerIdAtom,
  selectedCardAtom,
} from "../state";
import { isTestMode } from "../utils/testMode";
import { sendMoveIntent, sendClientIntent } from "../socket";
import { isTouchOnlyDevice } from "../utils/touchDetection";

interface Props {
  zone: LayoutZone;
  renderPile: (pileId: string, zone?: LayoutZone) => React.ReactNode;
  disabled?: boolean;
}

export function Zone({ zone, renderPile, disabled }: Props) {
  const isSinglePileZone = zone.piles.length === 1;
  const singlePileId = zone.piles[0];

  const [selectedCard, setSelectedCard] = useAtom(selectedCardAtom);
  const moveType = useAtomValue(moveTypeAtom);
  const testMode = isTestMode();
  const isClickMoveActive = testMode || moveType === "click";
  const view = useAtomValue(gameViewAtom);
  const myPlayerId = useAtomValue(playerIdAtom);
  const freeDragEnabled = useAtomValue(freeDragEnabledAtom);
  const { active } = useDndContext();
  const legalIntents = view?.legalIntents ?? [];
  const [isHovered, setIsHovered] = useState(false);

  const dragData = active?.data.current as
    | { pileId?: string; cardId?: number }
    | undefined;
  const dragCardId =
    typeof dragData?.cardId === "number" ? dragData.cardId : null;
  const dragFromPileId =
    typeof dragData?.pileId === "string" ? dragData.pileId : null;
  const activeCardId = isClickMoveActive ? selectedCard?.cardId : dragCardId;
  const activeFromPileId = isClickMoveActive
    ? selectedCard?.fromPileId
    : dragFromPileId;
  const hasActiveSelection =
    typeof activeCardId === "number" && !!activeFromPileId;

  const handleZoneClick = (e: React.MouseEvent) => {
    if (!view?.gameId || !myPlayerId || !selectedCard) return;
    const canFreeMoveClickTarget =
      freeDragEnabled && selectedCard.fromPileId !== singlePileId;
    if (!isDropTarget && !canFreeMoveClickTarget) return;

    e.stopPropagation();

    const matchingIntent = legalIntents.find(
      (intent) =>
        intent.type === "move" &&
        intent.fromPileId === selectedCard.fromPileId &&
        intent.toPileId === singlePileId &&
        (intent.cardId === selectedCard.cardId ||
          intent.cardIds?.includes(selectedCard.cardId))
    );

    if (matchingIntent) {
      sendClientIntent(matchingIntent);
    } else {
      sendMoveIntent(
        view.gameId,
        myPlayerId,
        selectedCard.fromPileId,
        singlePileId,
        selectedCard.cardId
      );
    }
    setSelectedCard(null);
  };

  const { setNodeRef, isOver } = useDroppable({
    id: `zone-proxy-${zone.id}`,
    disabled: !isSinglePileZone || disabled,
    data: {
      type: "zone-proxy",
      pileId: singlePileId,
    },
  });

  const isOverActive =
    isOver && (!dragFromPileId || dragFromPileId !== singlePileId);
  const isDropTarget =
    isSinglePileZone &&
    !freeDragEnabled &&
    hasActiveSelection &&
    legalIntents.some(
      (intent) =>
        intent.type === "move" &&
        intent.fromPileId === activeFromPileId &&
        intent.toPileId === singlePileId &&
        (intent.cardId === activeCardId ||
          intent.cardIds?.includes(activeCardId) === true)
    );
  const isTouchOnly = isTouchOnlyDevice();
  const isFreeMoveTarget =
    isSinglePileZone &&
    freeDragEnabled &&
    isClickMoveActive &&
    !!selectedCard &&
    selectedCard.fromPileId !== singlePileId &&
    (isHovered || isTouchOnly);

  const isHandZone = !!zone.handForPlayerId;
  const ownerSeat = view?.seats?.find((s) => s.seatId === zone.handForPlayerId);
  const isAi = ownerSeat?.aiRuntime !== "none";
  const ownerName = ownerSeat?.name || zone.handForPlayerId;
  const isMine = zone.handForPlayerId === myPlayerId;

  // Match original container styles exactly
  const containerClass = `relative flex items-center justify-center rounded-xl border transition-all duration-200 w-full h-full min-h-0 min-w-0 ${
    (isOverActive && freeDragEnabled) || isFreeMoveTarget
      ? "ring-4 ring-target/50 bg-target/10 border-target/50"
      : "border-white/10 bg-black/5"
  } ${isDropTarget ? "cursor-pointer" : ""}`;

  const rotationStyle =
    zone.rotation !== undefined
      ? { transform: `rotate(${zone.rotation}deg)` }
      : undefined;

  const animationStyle: React.CSSProperties = { ...rotationStyle };

  const labelElement =
    zone.label && zone.showLabel && !isSinglePileZone ? (
      <div className="absolute top-0 inset-x-0 flex justify-center pt-2 pointer-events-none z-20">
        <span className="text-[10px] font-bold uppercase tracking-widest text-ink leading-none inline-flex items-center gap-1.5">
          {isHandZone ? (
            <>
              {ownerName}
              {isMine && (
                <span className="px-1.5 py-[1px] rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200 text-[8px] font-semibold">
                  you
                </span>
              )}
              {isAi && (
                <span className="px-1.5 py-[1px] rounded-full bg-indigo-50 text-indigo-600 border border-indigo-200 text-[8px] font-semibold">
                  AI
                </span>
              )}
            </>
          ) : (
            zone.label
          )}
        </span>
      </div>
    ) : null;

  // Use subgrid if configured, otherwise use flexbox (backward compatible)
  if (zone.subgrid && zone.pileGrid) {
    const gridStyle = {
      display: "grid",
      gridTemplateRows: `repeat(${zone.subgrid.rows}, auto)`,
      gridTemplateColumns: `repeat(${zone.subgrid.cols}, auto)`,
      gap: zone.subgrid.gap ?? "var(--pile-gap, 8px)",
    };

    return (
      <div
        ref={isSinglePileZone ? setNodeRef : null}
        className={containerClass}
        onClick={isClickMoveActive ? handleZoneClick : undefined}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        style={animationStyle}
      >
        {isDropTarget && (
          <div className="absolute inset-0 rounded-xl ring-4 ring-target/50 bg-target/10 animate-pulse-slow pointer-events-none z-10" />
        )}
        {labelElement}
        <div style={gridStyle}>
          {zone.piles.map((pileId) => {
            const cell = zone.pileGrid![pileId];
            if (!cell) return null;

            const gridItemStyle = {
              gridRow: cell.rowspan
                ? `${cell.row + 1} / span ${cell.rowspan}`
                : cell.row + 1,
              gridColumn: cell.colspan
                ? `${cell.col + 1} / span ${cell.colspan}`
                : cell.col + 1,
            };

            return (
              <div
                key={pileId}
                style={gridItemStyle}
                className="min-w-0 min-h-0 flex items-center justify-center"
              >
                {renderPile(pileId, zone)}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Default flexbox rendering (backward compatible)
  const contentClass = `w-full h-full flex ${
    zone.pileOrientation === "vertical" ? "flex-col" : "flex-wrap"
  } items-center justify-center overflow-hidden`;

  return (
    <div
      ref={isSinglePileZone ? setNodeRef : null}
      className={containerClass}
      onClick={isClickMoveActive ? handleZoneClick : undefined}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={animationStyle}
    >
      {isDropTarget && (
        <div className="absolute inset-0 rounded-xl ring-4 ring-target/50 bg-target/10 animate-pulse-slow pointer-events-none z-10" />
      )}
      {labelElement}
      <div className={contentClass} style={{ gap: "var(--pile-gap, 8px)" }}>
        {zone.piles.map((pileId) => renderPile(pileId, zone))}
      </div>
    </div>
  );
}
