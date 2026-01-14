import { useEffect } from "react";

export interface FloatingActionItem {
  id: string;
  label: string;
  x: number;
  y: number;
}

interface Props {
  actions: FloatingActionItem[];
  onComplete: (id: string) => void;
  /** Duration in ms for the float/fade animation + auto-dismiss. Defaults to existing behavior. */
  durationMs?: number;
}

export function FloatingActionOverlay({
  actions,
  onComplete,
  durationMs,
}: Props) {
  const resolvedDurationMs = durationMs ?? 1600;

  return (
    <div className="fixed inset-0 pointer-events-none z-[100] overflow-hidden">
      {actions.map((action) => (
        <FloatingAction
          key={action.id}
          action={action}
          onComplete={() => onComplete(action.id)}
          durationMs={resolvedDurationMs}
          setAnimationDuration={durationMs !== undefined}
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
  useEffect(() => {
    const timer = window.setTimeout(onComplete, durationMs); // Slightly longer than animation
    return () => clearTimeout(timer);
  }, [durationMs, onComplete]);

  return (
    <div
      className="absolute animate-float-up-fade flex flex-col items-center"
      style={{
        left: action.x,
        top: action.y,
        animationDuration: setAnimationDuration ? `${durationMs}ms` : undefined,
      }}
    >
      <div className="px-4 py-2 bg-primary text-action-ink rounded-full shadow-lg border border-surface-3/30 font-bold whitespace-nowrap">
        {action.label}
      </div>
      {/* Optional: a small tail or pointer could go here */}
    </div>
  );
}
