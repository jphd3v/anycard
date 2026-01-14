import { useDroppable } from "@dnd-kit/core";
import { useAtom, useAtomValue } from "jotai";
import type { LayoutZone } from "../../../shared/schemas";
import {
  gameViewAtom,
  moveTypeAtom,
  playerIdAtom,
  selectedCardAtom,
} from "../state";
import { isTestMode } from "../utils/testMode";
import { sendMoveIntent } from "../socket";

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
  const legalIntents = view?.legalIntents ?? [];

  const isDropTarget =
    isSinglePileZone &&
    isClickMoveActive &&
    !!selectedCard &&
    legalIntents.some(
      (intent) =>
        intent.type === "move" &&
        intent.fromPileId === selectedCard.fromPileId &&
        intent.cardId === selectedCard.cardId &&
        intent.toPileId === singlePileId
    );

  const handleZoneClick = (e: React.MouseEvent) => {
    if (!isDropTarget || !view?.gameId || !myPlayerId || !selectedCard) return;

    e.stopPropagation();

    sendMoveIntent(
      view.gameId,
      myPlayerId,
      selectedCard.fromPileId,
      singlePileId,
      selectedCard.cardId
    );
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

  // Match original container styles exactly
  const containerClass = `relative flex items-center justify-center rounded-xl border transition-all duration-200 w-full h-full min-h-0 min-w-0 ${
    isOver
      ? "ring-4 ring-blue-400/50 bg-blue-400/10 border-blue-400/50"
      : "border-white/10 bg-black/5"
  } ${isDropTarget ? "cursor-pointer" : ""}`;
  const contentClass =
    "w-full h-full flex flex-wrap items-center justify-center overflow-hidden";

  return (
    <div
      ref={isSinglePileZone ? setNodeRef : null}
      className={containerClass}
      onClick={isClickMoveActive ? handleZoneClick : undefined}
    >
      {isDropTarget && (
        <div className="absolute inset-0 rounded-xl ring-4 ring-target/70 animate-pulse pointer-events-none z-10" />
      )}
      <div className={contentClass} style={{ gap: "var(--pile-gap, 8px)" }}>
        {zone.piles.map((pileId) => renderPile(pileId, zone))}
      </div>
    </div>
  );
}
