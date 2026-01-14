import { useEffect, useRef, useState, useCallback } from "react";
import type { FloatingWidgetConfig, GameView } from "../../../shared/schemas";
import { ActionsGrid } from "./ActionsGrid";
import { ScoreboardGrid } from "./ScoreboardGrid";

interface Props {
  config:
    | FloatingWidgetConfig
    | {
        widget: "actions" | "scoreboards";
        position?: string;
        defaultOpen?: boolean;
      };
  view: GameView;
  onActionClick: (actionId: string) => void;
  actionsDisabled?: boolean;
  // Controlled mode props
  isOpen?: boolean;
  onToggle?: (isOpen: boolean) => void;
  showTrigger?: boolean;
  className?: string;
  panelClassName?: string;
}

// Icon: Lightning Bolt (for Actions)
export function LightningIcon({
  className = "w-6 h-6",
}: {
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      className={className}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"
      />
    </svg>
  );
}

// Icon: Simple Score Sheet (Paper Style)
export function ScoreTableIcon({
  className = "w-6 h-6",
  strokeWidth = 2,
}: {
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={strokeWidth}
      stroke="currentColor"
      className={className}
    >
      {/* The Paper Sheet:
          - Starts top-left (x=6, y=2)
          - Goes right to x=13
          - Angles down to x=20, y=9 (The Fold)
          - Goes down and around to close the shape
      */}
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 10v9.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2h7.5l5.5 5.5Z"
      />

      {/* The Folded Corner Line:
          - Completes the "paper" illusion
      */}
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 2v6h6" />

      {/* The Score Content:
          - Uses 'Dots' as you suggested to imply list items (Rounds/Players)
          - Simple lines for the score values
      */}

      {/* Row 1 */}
      <circle cx="9" cy="11" r="1" fill="currentColor" stroke="none" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 11h4" />

      {/* Row 2 */}
      <circle cx="9" cy="15" r="1" fill="currentColor" stroke="none" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 15h4" />

      {/* Row 3 */}
      <circle cx="9" cy="19" r="1" fill="currentColor" stroke="none" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 19h4" />
    </svg>
  );
}

export function FloatingWidget({
  config,
  view,
  onActionClick,
  actionsDisabled = false,
  isOpen: controlledIsOpen,
  onToggle,
  showTrigger = true,
  className,
  panelClassName,
}: Props) {
  const isSingleAction =
    config.widget === "actions" &&
    !!view.actions &&
    view.actions.rows === 1 &&
    view.actions.cols === 1 &&
    view.actions.cells.length === 1;

  const [internalIsOpen, setInternalIsOpen] = useState(!!config.defaultOpen);
  const isControlled = controlledIsOpen !== undefined;
  const isOpen = isControlled ? controlledIsOpen : internalIsOpen;

  const handleToggle = useCallback(
    (newState: boolean) => {
      if (isControlled) {
        onToggle?.(newState);
      } else {
        setInternalIsOpen(newState);
      }
    },
    [isControlled, onToggle]
  );

  const autoClosedBecauseEmptyRef = useRef(false);

  const isEmptyActions =
    config.widget === "actions" &&
    (!view.actions ||
      view.actions.rows === 0 ||
      view.actions.cols === 0 ||
      view.actions.cells.length === 0);

  useEffect(() => {
    if (isOpen && isEmptyActions) {
      handleToggle(false);
      autoClosedBecauseEmptyRef.current = true;
    }
  }, [isEmptyActions, isOpen, handleToggle]);

  useEffect(() => {
    // If we auto-closed because actions were briefly empty (common at game start),
    // reopen once actions become available again when defaultOpen is enabled.
    if (
      !isOpen &&
      autoClosedBecauseEmptyRef.current &&
      !isEmptyActions &&
      config.defaultOpen
    ) {
      handleToggle(true);
      autoClosedBecauseEmptyRef.current = false;
    }
  }, [config.defaultOpen, isEmptyActions, isOpen, handleToggle]);

  // Position Logic for the Container
  const position = config.position || "bottom-right";
  const defaultContainerClasses =
    {
      "top-left": "absolute top-2 left-2 flex-col items-start",
      "top-right": "absolute top-2 right-2 flex-col items-end",
      "bottom-left": "absolute bottom-2 left-2 flex-col-reverse items-start",
      "bottom-right": "absolute bottom-2 right-2 flex-col-reverse items-end",
      center:
        "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex-col items-center",
    }[position] || "absolute bottom-2 right-2 flex-col-reverse items-end";

  // Expansion Logic (Origin for scale transition)
  const originClass =
    {
      "top-left": "origin-top-left",
      "top-right": "origin-top-right",
      "bottom-left": "origin-bottom-left",
      "bottom-right": "origin-bottom-right",
      center: "origin-center",
    }[position] || "origin-bottom-right";

  const finalContainerClass =
    (className ?? `${defaultContainerClasses} flex gap-2 z-50`) +
    " pointer-events-none";

  return (
    <div className={finalContainerClass}>
      {/* Trigger Button - Styles match GameHUD menu button (button-secondary) */}
      {showTrigger && (
        <button
          onClick={() => handleToggle(!isOpen)}
          disabled={isEmptyActions}
          className={`
            pointer-events-auto
            button-base button-icon button-secondary
            h-9 w-9 sm:h-11 sm:w-11
            rounded-full shadow-floating
            hover:scale-105 active:scale-95 z-50
            disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:active:scale-100
            ${isOpen ? "ring-2 ring-primary" : ""}
          `}
          title={
            isEmptyActions ? "No actions available" : `Toggle ${config.widget}`
          }
        >
          {config.widget === "actions" ? <LightningIcon /> : <ScoreTableIcon />}
        </button>
      )}

      {/* Popup Overlay */}
      <div
        className={`
          transition-all duration-300 ease-out pointer-events-auto
          ${originClass} translate-x-0 translate-y-0
          ${
            isOpen
              ? "scale-100 opacity-100 visible"
              : "scale-95 opacity-0 invisible"
          }
          ${panelClassName ?? ""}
        `}
        data-open={isOpen}
        style={{
          minWidth: "220px",
          width: "max-content",
          maxWidth: "min(600px, 90vw)",
          maxHeight: "min(400px, 75vh)",
        }}
      >
        <div className="overflow-hidden rounded-xl border border-surface-3 bg-surface-1/95 backdrop-blur-md shadow-floating flex flex-col max-h-[inherit] overflow-y-auto">
          {config.widget === "actions" && view.actions && (
            // Added padding here specifically for actions so buttons don't touch edges
            <div className={isSingleAction ? "w-full p-2" : "h-64 w-full p-2"}>
              <ActionsGrid
                actions={view.actions}
                onActionClick={onActionClick}
                disabled={actionsDisabled}
              />
            </div>
          )}

          {config.widget === "scoreboards" && view.scoreboards && (
            <div className="flex flex-col">
              {view.scoreboards.map((sb) => (
                // ScoreboardGrid now handles its own internal layout flush to edges
                <ScoreboardGrid key={sb.id} scoreboard={sb} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
