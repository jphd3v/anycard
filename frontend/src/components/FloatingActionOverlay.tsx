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
}

export function FloatingActionOverlay({ actions, onComplete }: Props) {
  return (
    <div className="fixed inset-0 pointer-events-none z-[100] overflow-hidden">
      {actions.map((action) => (
        <FloatingAction
          key={action.id}
          action={action}
          onComplete={() => onComplete(action.id)}
        />
      ))}
    </div>
  );
}

function FloatingAction({
  action,
  onComplete,
}: {
  action: FloatingActionItem;
  onComplete: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onComplete, 1600); // Slightly longer than animation
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <div
      className="absolute animate-float-up-fade flex flex-col items-center"
      style={{
        left: action.x,
        top: action.y,
      }}
    >
      <div className="px-4 py-2 bg-primary text-action-ink rounded-full shadow-lg border border-surface-3/30 font-bold whitespace-nowrap">
        {action.label}
      </div>
      {/* Optional: a small tail or pointer could go here */}
    </div>
  );
}
