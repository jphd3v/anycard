import type { GameLayout, GameView, LayoutZone } from "../../../shared/schemas";

/**
 * Rotates the entire game layout by a given angle (in radians).
 * Supports multiples of 90 degrees (PI/2).
 */
export function rotateLayout(layout: GameLayout, angle: number): GameLayout {
  // Normalize angle to [0, 2PI)
  const normAngle = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

  // Use a small epsilon for float comparisons
  if (normAngle < 0.01 || normAngle > 2 * Math.PI - 0.01) return layout;

  const { rows, cols, zones, pileStyles } = layout;
  const r0 = (rows - 1) / 2;
  const c0 = (cols - 1) / 2;

  const cos = Math.round(Math.cos(normAngle));
  const sin = Math.round(Math.sin(normAngle));

  const is90or270 = Math.abs(sin) === 1;

  const newRows = is90or270 ? cols : rows;
  const newCols = is90or270 ? rows : cols;

  const newR0 = (newRows - 1) / 2;
  const newC0 = (newCols - 1) / 2;

  const newZones = (zones || []).map((zone) => {
    if (!zone || !zone.cell) return zone;
    const { row, col, rowspan = 1, colspan = 1 } = zone.cell;

    // Rotate center of the zone cell
    const r_center = row + (rowspan - 1) / 2;
    const c_center = col + (colspan - 1) / 2;

    const dr = r_center - r0;
    const dc = c_center - c0;

    // Standard rotation:
    // dc' = dc * cos - dr * sin
    // dr' = dc * sin + dr * cos
    // (Using screen coordinates where r is y and c is x)
    const dc_new = dc * cos - dr * sin;
    const dr_new = dc * sin + dr * cos;

    // New center relative to new grid center
    const r_new_center = newR0 + dr_new;
    const c_new_center = newC0 + dc_new;

    // Swap rowspan/colspan if rotated 90/270
    const newRowspan = is90or270 ? colspan : rowspan;
    const newColspan = is90or270 ? rowspan : colspan;

    const newRow = Math.round(r_new_center - (newRowspan - 1) / 2);
    const newCol = Math.round(c_new_center - (newColspan - 1) / 2);

    return {
      ...zone,
      cell: {
        ...zone.cell,
        row: newRow,
        col: newCol,
        rowspan: newRowspan,
        colspan: newColspan,
      },
    };
  });

  // Rotate pile fanning orientations if needed
  const newPileStyles = { ...pileStyles };
  if (is90or270 && newPileStyles) {
    for (const pileId in newPileStyles) {
      const style = newPileStyles[pileId];
      if (style.layout === "horizontal") {
        newPileStyles[pileId] = { ...style, layout: "vertical" };
      } else if (style.layout === "vertical") {
        newPileStyles[pileId] = { ...style, layout: "horizontal" };
      }
    }
  }

  return {
    ...layout,
    rows: newRows,
    cols: newCols,
    zones: newZones,
    pileStyles: newPileStyles,
  };
}

function getHandPileIds(layout: GameLayout): string[] {
  if (!layout?.pileStyles) return [];

  return Object.entries(layout.pileStyles)
    .filter(([, style]) => style?.isHand)
    .map(([pileId]) => pileId);
}

function getHandZones(layout: GameLayout): LayoutZone[] {
  if (!layout?.zones?.length) return [];

  const handPileIds = new Set(getHandPileIds(layout));
  if (handPileIds.size === 0) return [];

  return layout.zones.filter(
    (zone) => zone?.piles?.some((pileId) => handPileIds.has(pileId)) ?? false
  );
}

/**
 * Finds the zone that primarily belongs to the player.
 */
function getPlayerPrimaryZone(
  view: GameView,
  layout: GameLayout,
  playerId: string
): LayoutZone | null {
  if (!view || !layout || !layout.zones) return null;

  // Try by piles first (most reliable as it's the actual game state)
  const playerPiles = (view.piles || [])
    .filter((p) => p && p.ownerId === playerId)
    .map((p) => p.id);

  const handPileIds = new Set(getHandPileIds(layout));
  const playerHandPiles = playerPiles.filter((pId) => handPileIds.has(pId));

  let candidateZones =
    playerHandPiles.length > 0
      ? layout.zones.filter(
          (z) =>
            z &&
            z.piles &&
            z.piles.some((pId: string) => playerHandPiles.includes(pId))
        )
      : [];

  if (candidateZones.length === 0) {
    candidateZones = layout.zones.filter(
      (z) =>
        z && z.piles && z.piles.some((pId: string) => playerPiles.includes(pId))
    );
  }

  // Fallback 1: Try by zone ID/label matching playerId
  if (candidateZones.length === 0) {
    candidateZones = layout.zones.filter((z) => {
      if (!z) return false;
      const id = (z.id || "").toLowerCase();
      const pid = (playerId || "").toLowerCase();
      return id.includes(pid) || z.label?.toLowerCase().includes(pid);
    });
  }

  // Fallback 2: Common seat names (N/S/E/W mapping to north/south/east/west)
  if (candidateZones.length === 0) {
    const pid = (playerId || "").toLowerCase();
    const seatMap: Record<string, string> = {
      n: "north",
      s: "south",
      e: "east",
      w: "west",
    };
    const mapped = seatMap[pid];
    if (mapped) {
      candidateZones = layout.zones.filter(
        (z) =>
          z &&
          ((z.id || "").toLowerCase().includes(mapped) ||
            z.label?.toLowerCase().includes(mapped))
      );
    }
  }

  if (candidateZones.length === 0) return null;

  // Find the one furthest from center (usually the hand zone at the edge)
  const r0 = (layout.rows - 1) / 2;
  const c0 = (layout.cols - 1) / 2;

  return candidateZones.reduce((prev, curr) => {
    const p_r =
      (prev.cell?.row ?? 0) + ((prev.cell?.rowspan || 1) - 1) / 2 - r0;
    const p_c =
      (prev.cell?.col ?? 0) + ((prev.cell?.colspan || 1) - 1) / 2 - c0;
    const c_r =
      (curr.cell?.row ?? 0) + ((curr.cell?.rowspan || 1) - 1) / 2 - r0;
    const c_c =
      (curr.cell?.col ?? 0) + ((curr.cell?.colspan || 1) - 1) / 2 - c0;

    const p_dist = p_r * p_r + p_c * p_c;
    const c_dist = c_r * c_r + c_c * c_c;

    return c_dist > p_dist ? curr : prev;
  });
}

/**
 * Finds the zone that is "at the bottom" in the original layout to use as reference.
 */
function getBottomReferenceZone(layout: GameLayout): LayoutZone | null {
  if (!layout || !layout.zones || layout.zones.length === 0) return null;

  const handZones = getHandZones(layout);

  // Find player zones (South, P1, etc) when no explicit hand piles exist.
  const playerZones =
    handZones.length > 0
      ? []
      : (layout.zones || []).filter(
          (z) =>
            z &&
            ((z.id || "").toLowerCase().includes("south") ||
              (z.id || "").toLowerCase().includes("p1") ||
              z.label?.toLowerCase().includes("south") ||
              z.label?.toLowerCase().includes("player 1"))
        );

  const pool =
    handZones.length > 0
      ? handZones
      : playerZones.length > 0
        ? playerZones
        : layout.zones;
  if (!pool || pool.length === 0) return layout.zones?.[0] || null;

  return pool.reduce((prev, curr) => {
    const prevRow = prev.cell?.row ?? 0;
    const currRow = curr.cell?.row ?? 0;
    if (currRow > prevRow) return curr;
    if (currRow === prevRow) {
      const centerCol = (layout.cols - 1) / 2;
      const prevCol = prev.cell?.col ?? 0;
      const currCol = curr.cell?.col ?? 0;
      if (Math.abs(currCol - centerCol) < Math.abs(prevCol - centerCol)) {
        return curr;
      }
    }
    return prev;
  });
}

/**
 * Heuristic to detect if a layout is designed with players side-by-side.
 * In such cases, we typically want to preserve the original view even if
 * the player is not at the "bottom", as rotating might break the layout's intent.
 */
function isSideBySideLayout(layout: GameLayout): boolean {
  if (!layout || !layout.zones) return false;

  const handZones = getHandZones(layout);
  const useHandZones = handZones.length > 0;
  const zonesToCheck = useHandZones ? handZones : layout.zones;

  const playerRows = new Set<number>();
  let playerZoneCount = 0;

  for (const zone of zonesToCheck) {
    const id = (zone.id || "").toLowerCase();
    const label = (zone.label || "").toLowerCase();
    const isPlayerZone = useHandZones
      ? true
      : id.includes("player") ||
        id.includes("hand") ||
        label.includes("player") ||
        label.includes("hand") ||
        /p\d/.test(id) ||
        ["north", "south", "east", "west"].some((s) => id.includes(s));

    if (isPlayerZone) {
      playerRows.add(zone.cell.row);
      playerZoneCount++;
    }
  }

  // If we have multiple player zones and they all sit in the same row,
  // it's a "flat" or "side-by-side" layout.
  return playerRows.size === 1 && playerZoneCount > 1;
}

/**
 * Calculates the rotation angle required to put the player's primary zone at the bottom.
 */
export function getRotationAngle(
  layout: GameLayout,
  view: GameView,
  playerId: string
): number {
  if (!playerId || playerId.startsWith("spectator")) return 0;
  if (isSideBySideLayout(layout)) return 0;

  const playerZone = getPlayerPrimaryZone(view, layout, playerId);
  if (!playerZone) return 0;

  const refZone = getBottomReferenceZone(layout);
  if (!refZone || playerZone.id === refZone.id) return 0;

  const r0 = (layout.rows - 1) / 2;
  const c0 = (layout.cols - 1) / 2;

  const p_r =
    playerZone.cell.row + ((playerZone.cell.rowspan || 1) - 1) / 2 - r0;
  const p_c =
    playerZone.cell.col + ((playerZone.cell.colspan || 1) - 1) / 2 - c0;

  const r_r = refZone.cell.row + ((refZone.cell.rowspan || 1) - 1) / 2 - r0;
  const r_c = refZone.cell.col + ((refZone.cell.colspan || 1) - 1) / 2 - c0;

  const p_angle = Math.atan2(p_r, p_c);
  const r_angle = Math.atan2(r_r, r_c);

  const diff = r_angle - p_angle;
  // Round to nearest 90 degrees
  return Math.round(diff / (Math.PI / 2)) * (Math.PI / 2);
}
