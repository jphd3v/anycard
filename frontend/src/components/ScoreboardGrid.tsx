import React from "react";
import { useAtomValue } from "jotai";
import type { Scoreboard } from "../../../shared/schemas";
import { highlightedScoreboardCellsAtom } from "../state";

type Props = {
  scoreboard: Scoreboard;
};

export function ScoreboardGrid({ scoreboard }: Props) {
  const { rows, cols, cells, title } = scoreboard;
  const highlightedMap = useAtomValue(highlightedScoreboardCellsAtom);
  const highlighted = new Set(highlightedMap[scoreboard.id] ?? []);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const gridRef = React.useRef<HTMLDivElement | null>(null);
  const [isCondensed, setIsCondensed] = React.useState(false);
  // Font sizes are defined as CSS variables in index.css with responsive media queries
  const normalFontSize = "var(--scoreboard-font-normal)";
  const condensedFontSize = "var(--scoreboard-font-condensed)";

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const grid = gridRef.current;
    if (!container || !grid) return;

    const measureOverflow = () => {
      const prev = container.style.getPropertyValue("--scoreboard-font-size");
      container.style.setProperty("--scoreboard-font-size", normalFontSize);
      const overflow =
        grid.scrollWidth > grid.clientWidth ||
        grid.scrollHeight > grid.clientHeight;
      container.style.setProperty("--scoreboard-font-size", prev);
      setIsCondensed(overflow);
    };

    measureOverflow();
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(container);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [rows, cols, cells, normalFontSize]);

  return (
    <div
      ref={containerRef}
      className="w-full flex flex-col bg-surface-1 rounded-xl border border-surface-3 shadow-sm overflow-hidden"
      style={{
        viewTransitionName: "none",
        ["--scoreboard-font-size" as string]: isCondensed
          ? condensedFontSize
          : normalFontSize,
      }}
    >
      {/* Title */}
      {title && (
        <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-ink-muted bg-surface-2/50 border-b border-surface-3">
          {title}
        </div>
      )}

      {/* Grid Content */}
      <div
        ref={gridRef}
        className="w-full"
        style={{
          display: "grid",
          gridTemplateRows: `repeat(${rows}, 1fr)`,
          gridTemplateColumns: `repeat(${cols}, minmax(max-content, 1fr))`,
        }}
      >
        {cells.map((cell, idx) => {
          const rowSpan = cell.rowspan ?? 1;
          const colSpan = cell.colspan ?? 1;

          let justifyContent: React.CSSProperties["justifyContent"] =
            "flex-start";
          if (cell.align === "center") justifyContent = "center";
          if (cell.align === "right") justifyContent = "flex-end";

          const isHeader = cell.role === "header";
          const isTotal = cell.role === "total";

          const fontWeight = isHeader || isTotal ? 600 : 400;
          const textColor = isHeader ? "text-ink-muted" : "text-ink";
          const bgClass = isHeader ? "bg-surface-2/20" : "";

          // Internal borders for table-like feel
          const borderClass =
            "border-b border-r border-surface-3/30 last:border-b-0";

          return (
            <div
              key={`${scoreboard.id}-${cell.row}-${cell.col}-${idx}`}
              className={`${textColor} ${bgClass} ${borderClass} ${
                highlighted.has(`${scoreboard.id}:${cell.row}:${cell.col}`)
                  ? "animate-cell-pop"
                  : ""
              }`}
              style={{
                gridRow: `${cell.row + 1} / span ${rowSpan}`,
                gridColumn: `${cell.col + 1} / span ${colSpan}`,
                padding: "4px 12px",
                display: "flex",
                alignItems: "center",
                justifyContent,
                fontWeight,
                fontVariantNumeric: "tabular-nums",
                fontSize: "var(--scoreboard-font-size)",
                whiteSpace: "nowrap",
              }}
            >
              {cell.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
