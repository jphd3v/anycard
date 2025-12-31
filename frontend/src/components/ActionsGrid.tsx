import type { ActionGrid, ActionCell } from "../../../shared/schemas";
import { useAtomValue } from "jotai";
import { highlightedActionIdAtom, highlightedActionLabelAtom } from "../state";
import { useMemo } from "react";

interface Props {
  actions: ActionGrid;
  onActionClick: (actionId: string) => void;
  disabled?: boolean;
  orientation?: "horizontal" | "vertical";
}

export function ActionsGrid({
  actions,
  onActionClick,
  disabled = false,
  orientation,
}: Props) {
  const highlightedActionId = useAtomValue(highlightedActionIdAtom);
  const highlightedActionLabel = useAtomValue(highlightedActionLabelAtom);

  const { rows, cols, cells } = useMemo(() => {
    if (!actions) return { rows: 0, cols: 0, cells: [] };
    if (!orientation) return actions;

    // Flatten cells and sort by original position (row-major order)
    const flattenedCells = [...actions.cells].sort(
      (a, b) => a.row - b.row || a.col - b.col
    );

    if (orientation === "vertical") {
      return {
        rows: flattenedCells.length,
        cols: 1,
        cells: flattenedCells.map((cell, index) => ({
          ...cell,
          row: index,
          col: 0,
          rowspan: 1,
          colspan: 1,
        })),
      };
    } else {
      // horizontal
      return {
        rows: 1,
        cols: flattenedCells.length,
        cells: flattenedCells.map((cell, index) => ({
          ...cell,
          row: 0,
          col: index,
          rowspan: 1,
          colspan: 1,
        })),
      };
    }
  }, [actions, orientation]);

  const isEmpty = rows === 0 || cols === 0 || cells.length === 0;

  // High density layouts (like Bridge keypad) need tighter spacing
  const isHighDensity = cols > 2;

  const gridStyle = {
    display: "grid" as const,
    gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    gap: isHighDensity ? "2px" : "8px", // gap-1 vs gap-2
    // Intrinsic size, but constrained to container
    width: "auto",
    height: "auto",
    maxWidth: "100%",
    maxHeight: "100%",
  };

  return (
    <div
      className={`
        actions-grid w-full h-full bg-panel rounded-lg border border-surface-3 shadow-sm flex flex-col items-center justify-center overflow-hidden
        transition-opacity transition-transform duration-200
        ${isEmpty ? "opacity-40 scale-[0.98]" : "opacity-100 scale-100"}
        ${isHighDensity ? "p-1" : "p-2"}
      `}
      style={{ viewTransitionName: "none" }}
    >
      {isEmpty ? (
        <div className="w-full h-full flex items-center justify-center text-xs font-bold uppercase tracking-widest text-ink-muted">
          {highlightedActionLabel ? (
            <div className="animate-action-pop px-3 py-2 rounded-md bg-surface-2/60 border border-surface-3">
              Last action: {highlightedActionLabel}
            </div>
          ) : (
            <div className="px-3 py-2 rounded-md">No actions</div>
          )}
        </div>
      ) : (
        <div style={gridStyle}>
          {cells.map((cell: ActionCell, index: number) => {
            const colSpan = cell.colspan || 1;
            const rowSpan = cell.rowspan || 1;

            return (
              <button
                key={`${cell.id}-${cell.row}-${cell.col}-${index}`}
                data-testid={`action:${cell.id}`}
                disabled={disabled || !cell.enabled}
                onClick={() => onActionClick(cell.id)}
                style={{
                  gridColumn: `${cell.col + 1} / span ${colSpan}`,
                  gridRow: `${cell.row + 1} / span ${rowSpan}`,
                  // Dynamic font size to handle dense layouts (Bridge) vs spacious ones
                  fontSize: "clamp(0.7rem, 1.5vw + 0.5rem, 0.95rem)",
                }}
                className={`
                  button-base button-primary rounded-md font-bold active:scale-[0.98]
                  flex items-center justify-center
                  w-full h-full
                  max-h-[80px] max-w-[240px]
                  leading-none
                  text-center whitespace-normal break-words
                  min-w-0
                  ${
                    isHighDensity
                      ? "px-1 py-1"
                      : "px-4 py-2 min-w-[80px] min-h-[40px]"
                  }
                  ${cell.id === highlightedActionId ? "animate-action-pop ring-2 ring-primary/60" : ""}
                `}
              >
                <span>{cell.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
