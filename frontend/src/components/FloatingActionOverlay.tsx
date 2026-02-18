import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface FloatingActionItem {
  id: string;
  label: string;
  x: number;
  y: number;
  durationMs?: number;
}

interface Props {
  actions: FloatingActionItem[];
  onComplete: (id: string) => void;
  /** Duration in ms for the float/fade animation + auto-dismiss. Defaults to existing behavior. */
  durationMs?: number;
  viewTransitionName?: string;
}

const HORIZONTAL_SAFE_PADDING_PX = 12;
const VERTICAL_SAFE_PADDING_PX = 12;
const FLOAT_UP_TRAVEL_PX = 50;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function FloatingActionOverlay({
  actions,
  onComplete,
  durationMs,
  viewTransitionName,
}: Props) {
  const resolvedDurationMs = durationMs ?? 1600;

  return (
    <div
      className="fixed inset-0 pointer-events-none z-[10000] overflow-hidden"
      style={viewTransitionName ? { viewTransitionName } : undefined}
    >
      {actions.map((action) => (
        <FloatingAction
          key={action.id}
          action={action}
          onComplete={() => onComplete(action.id)}
          durationMs={action.durationMs ?? resolvedDurationMs}
          setAnimationDuration={
            action.durationMs !== undefined || durationMs !== undefined
          }
        />
      ))}
    </div>
  );
}

function FloatingAction({
  action,
  onComplete,
  durationMs,
  setAnimationDuration,
}: {
  action: FloatingActionItem;
  onComplete: () => void;
  durationMs: number;
  setAnimationDuration: boolean;
}) {
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: action.x, top: action.y });

  useEffect(() => {
    const timer = window.setTimeout(onComplete, durationMs); // Slightly longer than animation
    return () => clearTimeout(timer);
  }, [durationMs, onComplete]);

  useLayoutEffect(() => {
    const recalculatePosition = () => {
      const bubbleEl = bubbleRef.current;
      const bubbleWidth = bubbleEl?.offsetWidth ?? 0;
      const bubbleHeight = bubbleEl?.offsetHeight ?? 0;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      const halfBubbleWidth = bubbleWidth / 2;
      const minLeft = halfBubbleWidth + HORIZONTAL_SAFE_PADDING_PX;
      const maxLeft = Math.max(
        minLeft,
        viewportWidth - halfBubbleWidth - HORIZONTAL_SAFE_PADDING_PX
      );
      const left = clamp(action.x, minLeft, maxLeft);

      // The animation moves the bubble up by FLOAT_UP_TRAVEL_PX from its anchor.
      const minTop = VERTICAL_SAFE_PADDING_PX + FLOAT_UP_TRAVEL_PX;
      const maxTop = Math.max(
        minTop,
        viewportHeight - bubbleHeight - VERTICAL_SAFE_PADDING_PX
      );
      const top = clamp(action.y, minTop, maxTop);

      setPosition((prev) => {
        if (prev.left === left && prev.top === top) {
          return prev;
        }
        return { left, top };
      });
    };

    recalculatePosition();
    window.addEventListener("resize", recalculatePosition);
    window.addEventListener("orientationchange", recalculatePosition);
    return () => {
      window.removeEventListener("resize", recalculatePosition);
      window.removeEventListener("orientationchange", recalculatePosition);
    };
  }, [action.x, action.y, action.label]);

  return (
    <div
      className="absolute animate-float-up-fade flex flex-col items-center"
      style={{
        left: position.left,
        top: position.top,
        animationDuration: setAnimationDuration ? `${durationMs}ms` : undefined,
      }}
    >
      <div
        ref={bubbleRef}
        className="max-w-[min(88vw,30rem)] px-3 py-2 sm:px-4 bg-primary text-action-ink rounded-2xl shadow-lg border border-surface-3/30 font-semibold text-[11px] sm:text-xs leading-snug text-center whitespace-normal break-words"
      >
        {action.label}
      </div>
      {/* Optional: a small tail or pointer could go here */}
    </div>
  );
}
