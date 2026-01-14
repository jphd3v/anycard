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

  // Match original container styles exactly
  const containerClass = `relative flex items-center justify-center rounded-xl border transition-all duration-200 w-full h-full min-h-0 min-w-0 ${
    (isOverActive && freeDragEnabled) || isFreeMoveTarget
      ? "ring-4 ring-target/50 bg-target/10 border-target/50"
      : "border-white/10 bg-black/5"
  } ${isDropTarget ? "cursor-pointer" : ""}`;
  const contentClass =
    "w-full h-full flex flex-wrap items-center justify-center overflow-hidden";

  return (
    <div
      ref={isSinglePileZone ? setNodeRef : null}
      className={containerClass}
      onClick={isClickMoveActive ? handleZoneClick : undefined}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {isDropTarget && (
        <div className="absolute inset-0 rounded-xl ring-4 ring-target/50 bg-target/10 animate-pulse-slow pointer-events-none z-10" />
      )}
      <div className={contentClass} style={{ gap: "var(--pile-gap, 8px)" }}>
        {zone.piles.map((pileId) => renderPile(pileId, zone))}
      </div>
    </div>
  );
}
