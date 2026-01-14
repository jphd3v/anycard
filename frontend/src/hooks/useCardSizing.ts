import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GameLayout, GameView, LayoutZone } from "../../../shared/schemas";

type CardVars = {
  cardHeightPx: number;
  cardWidthPx: number;
  fanRatio: number;
};

const DEFAULT_CARD_VARS: CardVars = {
  cardHeightPx: 170,
  cardWidthPx: 170 * (5 / 7),
  fanRatio: 0.25,
};

const MIN_TOUCH_HEIGHT = 64; // keep a comfortable hit target on touch
const MIN_FAN_RATIO_TOUCH = 0.3; // do not collapse fanning too far on touch

const PILE_CHROME_Y = { coarse: 72, fine: 64 }; // label + counters + breathing room
const HARD_MIN_HEIGHT = 32; // absolute floor to avoid complete collapse

// Determine if a pile layout is horizontal or vertical; others don't fan.
const layoutOrientation = (
  zone: LayoutZone | undefined,
  pileId: string,
  layout: GameLayout
) => {
  const override = layout.pileStyles?.[pileId];
  const pileLayout = override?.layout ?? "complete";
  if (pileLayout === "horizontal") return "horizontal";
  if (pileLayout === "vertical") return "vertical";
  return "other";
};

export function useCardSizing(
  layout: GameLayout | null,
  view: GameView | null,
  cardAspectRatio: number
) {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [styleVars, setStyleVars] = useState<Record<string, string>>({});
  const appliedKeysRef = useRef<string[]>([]);
  const cardAspect = useMemo(() => cardAspectRatio, [cardAspectRatio]);

  const applyCssVars = useCallback((vars: Record<string, string>) => {
    if (typeof document === "undefined") return;

    const rootStyle = document.documentElement.style;

    for (const key of appliedKeysRef.current) {
      if (!(key in vars)) {
        rootStyle.removeProperty(key);
      }
    }

    for (const [key, value] of Object.entries(vars)) {
      rootStyle.setProperty(key, value);
    }

    appliedKeysRef.current = Object.keys(vars);
  }, []);

  const isCoarsePointer = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(pointer: coarse)").matches,
    []
  );

  useLayoutEffect(() => {
    if (
      !layout ||
      !view ||
      !boardRef.current ||
      typeof window === "undefined"
    ) {
      setStyleVars({});
      applyCssVars({});
      return;
    }

    const compute = () => {
      const board = boardRef.current;
      if (!board) return;

      const rect = board.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const isLandscape = rect.width > rect.height;
      const baseFanRatio = isCoarsePointer ? (isLandscape ? 0.4 : 0.55) : 0.25;

      // Resolve grid gap to compute per-cell sizes.
      const computed = window.getComputedStyle(board);
      const zoneGapX =
        parseFloat(computed.columnGap || computed.gap || "8") || 0;
      const zoneGapY = parseFloat(computed.rowGap || computed.gap || "8") || 0;

      // Extract pile-gap from CSS variables (defaults to 24 if not found)
      const pileGap =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--pile-gap"
          )
        ) || 24;

      const cellWidth =
        (rect.width - zoneGapX * (layout.cols - 1)) / layout.cols;
      const cellHeight =
        (rect.height - zoneGapY * (layout.rows - 1)) / layout.rows;

      // Cap based on viewport; keep touch devices smaller but avoid undersizing landscape.
      const maxCap = isCoarsePointer
        ? Math.min(185, rect.height * 0.22)
        : Math.min(200, rect.height * 0.24);
      const minHeight = isCoarsePointer ? MIN_TOUCH_HEIGHT : 48;
      const normalChrome = isCoarsePointer
        ? PILE_CHROME_Y.coarse
        : PILE_CHROME_Y.fine;
      const compactChrome = isCoarsePointer ? 24 : 20;

      let limitingHeight = Number.POSITIVE_INFINITY;
      let fanRatio = baseFanRatio;
      let baseZoneBound = Number.POSITIVE_INFINITY;

      const pileCountById = new Map<string, number>();
      for (const pile of view.piles) {
        pileCountById.set(pile.id, pile.cards.length);
      }

      // Track if any pile forces us below the minimum with the base fan.
      let needsFanTightening = false;
      let maxAllowedFanForMinHeight = Number.POSITIVE_INFINITY;

      const getPileSlotSize = (zone: LayoutZone, currentFanRatio: number) => {
        const colSpan = zone.cell.colspan ?? 1;
        const rowSpan = zone.cell.rowspan ?? 1;
        const zoneWidth = cellWidth * colSpan + zoneGapX * (colSpan - 1);
        const zoneHeight = cellHeight * rowSpan + zoneGapY * (rowSpan - 1);

        const pileSlots = Math.max(zone.piles?.length ?? 1, 1);

        let bestBound = -1;
        let bestSlot = { availableWidth: 0, availableHeight: 0 };

        // Pre-calculate max fanning factors for this zone's piles to help grid selection.
        // This ensures we pick a grid (cols vs rows) that favors the actual fanning direction.
        let maxHorizFanFactor = 1;
        let maxVertFanFactor = 1;
        let zoneMaxChrome = compactChrome;

        for (const pileId of zone.piles) {
          const count = pileCountById.get(pileId) ?? 0;
          const style = layout.pileStyles?.[pileId];
          const chrome = style?.hideTitle ? compactChrome : normalChrome;
          zoneMaxChrome = Math.max(zoneMaxChrome, chrome);

          if (count <= 1) continue;
          const orientation = layoutOrientation(zone, pileId, layout);
          if (orientation === "horizontal") {
            maxHorizFanFactor = Math.max(
              maxHorizFanFactor,
              1 + currentFanRatio * (count - 1)
            );
          } else if (orientation === "vertical") {
            maxVertFanFactor = Math.max(
              maxVertFanFactor,
              1 + currentFanRatio * (count - 1)
            );
          }
        }

        // Try all possible (cols, rows) combinations that can hold the piles.
        for (let cols = 1; cols <= pileSlots; cols++) {
          const rows = Math.ceil(pileSlots / cols);

          const widthMinusGap = zoneWidth - pileGap * Math.max(cols - 1, 0);
          // Account for label+counter chrome PER ROW in the zone.
          const heightMinusGap =
            zoneHeight - pileGap * Math.max(rows - 1, 0) - zoneMaxChrome * rows;

          const availableWidth = Math.max(widthMinusGap / cols, 0);
          const availableHeight = Math.max(heightMinusGap / rows, 0);

          // Maximum height that fits considering both aspect ratio and fanning.
          const bound = Math.min(
            availableHeight / maxVertFanFactor,
            availableWidth / (cardAspect * maxHorizFanFactor)
          );

          if (bound > bestBound) {
            bestBound = bound;
            bestSlot = { availableWidth, availableHeight };
          }
        }

        return bestSlot;
      };

      for (const zone of layout.zones) {
        if (!zone.piles?.length) continue;
        const { availableWidth, availableHeight } = getPileSlotSize(
          zone,
          baseFanRatio
        );

        const baseBound = Math.min(
          availableHeight,
          availableWidth / cardAspect
        );
        if (Number.isFinite(baseBound)) {
          baseZoneBound = Math.min(baseZoneBound, baseBound);
        }

        for (const pileId of zone.piles) {
          const count = pileCountById.get(pileId) ?? 0;
          const orientation = layoutOrientation(zone, pileId, layout);
          if (count <= 1 || orientation === "other") continue;

          if (orientation === "horizontal") {
            const denom = cardAspect * (1 + baseFanRatio * (count - 1));
            const maxH = availableWidth / denom;
            limitingHeight = Math.min(limitingHeight, maxH);

            // If base fan overflows the minimum height, find a tighter fan that would fit.
            const allowedFan =
              (availableWidth / (minHeight * cardAspect) - 1) / (count - 1);
            maxAllowedFanForMinHeight = Math.min(
              maxAllowedFanForMinHeight,
              allowedFan
            );
            if (maxH < minHeight) needsFanTightening = true;
          } else if (orientation === "vertical") {
            const denom = 1 + baseFanRatio * (count - 1);
            const maxH = availableHeight / denom;
            limitingHeight = Math.min(limitingHeight, maxH);

            const allowedFan = (availableHeight / minHeight - 1) / (count - 1);
            maxAllowedFanForMinHeight = Math.min(
              maxAllowedFanForMinHeight,
              allowedFan
            );
            if (maxH < minHeight) needsFanTightening = true;
          }
        }
      }

      if (needsFanTightening) {
        // Reduce fan just enough to let minHeight fit, but keep a generous overlap on touch.
        const tightened = Math.max(
          isCoarsePointer ? MIN_FAN_RATIO_TOUCH : 0.2,
          Math.min(baseFanRatio, maxAllowedFanForMinHeight)
        );
        fanRatio = tightened;

        // Recompute limiting height with the tightened fan.
        limitingHeight = Number.POSITIVE_INFINITY;
        for (const zone of layout.zones) {
          if (!zone.piles?.length) continue;
          const { availableWidth, availableHeight } = getPileSlotSize(
            zone,
            fanRatio
          );

          for (const pileId of zone.piles) {
            const count = pileCountById.get(pileId) ?? 0;
            const orientation = layoutOrientation(zone, pileId, layout);
            if (count <= 1 || orientation === "other") continue;

            if (orientation === "horizontal") {
              const denom = cardAspect * (1 + fanRatio * (count - 1));
              limitingHeight = Math.min(limitingHeight, availableWidth / denom);
            } else if (orientation === "vertical") {
              const denom = 1 + fanRatio * (count - 1);
              limitingHeight = Math.min(
                limitingHeight,
                availableHeight / denom
              );
            }
          }
        }
      }

      const combinedLimit = Math.min(limitingHeight, baseZoneBound);

      if (!Number.isFinite(combinedLimit)) {
        const defaults = {
          "--card-height": `${DEFAULT_CARD_VARS.cardHeightPx}px`,
          "--card-width": `${DEFAULT_CARD_VARS.cardWidthPx}px`,
          "--fan-x": `${DEFAULT_CARD_VARS.cardWidthPx * baseFanRatio}px`,
          "--fan-y": `${DEFAULT_CARD_VARS.cardHeightPx * baseFanRatio}px`,
        };
        setStyleVars(defaults);
        applyCssVars(defaults);
        return;
      }

      const finalHeight = Math.min(
        Math.max(combinedLimit, HARD_MIN_HEIGHT),
        maxCap
      );
      const finalWidth = finalHeight * cardAspect;

      const vars = {
        "--card-height": `${finalHeight}px`,
        "--card-width": `${finalWidth}px`,
        "--fan-x": `${finalWidth * fanRatio}px`,
        "--fan-y": `${finalHeight * fanRatio}px`,
      };

      setStyleVars(vars);
      applyCssVars(vars);
    };

    const observer = new ResizeObserver(compute);
    observer.observe(boardRef.current);
    compute();

    return () => {
      observer.disconnect();
      applyCssVars({});
    };
  }, [layout, view, isCoarsePointer, applyCssVars, cardAspect]);

  return { boardRef, styleVars };
}
