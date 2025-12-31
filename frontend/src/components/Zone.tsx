import { useDroppable } from "@dnd-kit/core";
import type { LayoutZone } from "../../../shared/schemas";

interface Props {
  zone: LayoutZone;
  renderPile: (pileId: string, zone?: LayoutZone) => React.ReactNode;
  disabled?: boolean;
}

export function Zone({ zone, renderPile, disabled }: Props) {
  const isSinglePileZone = zone.piles.length === 1;
  const singlePileId = zone.piles[0];

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
  }`;
  const contentClass =
    "w-full h-full flex flex-wrap items-center justify-center gap-2 overflow-hidden";

  return (
    <div ref={isSinglePileZone ? setNodeRef : null} className={containerClass}>
      <div className={contentClass}>
        {zone.piles.map((pileId) => renderPile(pileId, zone))}
      </div>
    </div>
  );
}
