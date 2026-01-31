import React from "react";
import { useAtomValue } from "jotai";
import type { Scoreboard } from "../../../shared/schemas";
import { highlightedScoreboardCellsAtom } from "../state";
import { ScrollShadowWrapper } from "./ScrollShadowWrapper";

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

  // For very tall scoreboards (like cribbage), use extra compact styling
  const isVeryTall = rows > 50;

  // Font sizes: very tall scoreboards need much smaller fonts
  const normalFontSize = isVeryTall
    ? "clamp(0.5rem, 1.2vw, 0.65rem)" // Cribbage: smaller
    : "var(--scoreboard-font-normal)"; // Normal games
  const condensedFontSize = isVeryTall
    ? "clamp(0.45rem, 1vw, 0.6rem)" // Cribbage: even smaller when condensed
    : "var(--scoreboard-font-condensed)"; // Normal games

  const cellPadding = isVeryTall ? "2px 8px" : "4px 12px";

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

      {/* Grid Content with Scroll Shadows */}
      <ScrollShadowWrapper className="flex-1">
        <div
          ref={gridRef}
          className="w-full"
          style={{
            display: "grid",
            gridTemplateRows: `repeat(${rows}, auto)`,
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
            const isSeparator = cell.role === "separator";

            const fontWeight = isHeader || isTotal ? 600 : 400;
            const textColor = isHeader ? "text-ink-muted" : "text-ink";
            const bgClass = isHeader ? "bg-surface-2/20" : "";

            // Separator cells render as empty space
            const cellContent = isSeparator ? "" : cell.text;

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
                  padding: cellPadding,
                  display: "flex",
                  alignItems: "center",
                  justifyContent,
                  fontWeight,
                  fontVariantNumeric: "tabular-nums",
                  fontSize: "var(--scoreboard-font-size)",
                  whiteSpace: "nowrap",
                }}
              >
                {cellContent}
              </div>
            );
          })}
        </div>
      </ScrollShadowWrapper>
    </div>
  );
}
