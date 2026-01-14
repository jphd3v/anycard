import { useEffect } from "react";

export interface AnnouncementItem {
  id: string;
  text: string;
  x: number;
  y: number;
}

interface Props {
  items: AnnouncementItem[];
  onComplete: (id: string) => void;
}

export function AnnouncementOverlay({ items, onComplete }: Props) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="fixed inset-0 pointer-events-none z-[120] overflow-hidden">
      {items.map((item) => (
        <AnnouncementBubble
          key={item.id}
          item={item}
          onComplete={() => onComplete(item.id)}
        />
      ))}
    </div>
  );
}

function AnnouncementBubble({
  item,
  onComplete,
}: {
  item: AnnouncementItem;
  onComplete: () => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onComplete, 1600);
    return () => window.clearTimeout(timer);
  }, [onComplete]);

  return (
    <div
      className="absolute animate-float-up-fade flex items-center"
      style={{ left: item.x, top: item.y }}
    >
      <div className="px-4 py-2 rounded-full bg-surface-1/95 text-ink border border-surface-3 shadow-floating text-[11px] sm:text-xs font-semibold tracking-wide whitespace-nowrap">
        {item.text}
      </div>
    </div>
  );
}
