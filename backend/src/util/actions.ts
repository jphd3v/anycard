import type {
  ActionGrid,
  ClientIntent,
  GameView,
} from "../../../shared/schemas.js";

export function filterActionsByLegalIntents(
  actions: ActionGrid,
  legalIntents: ClientIntent[] | undefined
): ActionGrid {
  if (!legalIntents) {
    return actions;
  }

  const legalActionIds = new Set(
    legalIntents
      .filter(
        (intent): intent is Extract<ClientIntent, { type: "action" }> =>
          intent.type === "action"
      )
      .map((intent) => intent.action)
  );

  if (legalActionIds.size === 0) {
    return { rows: 0, cols: 0, cells: [] };
  }

  const legalCells = actions.cells.filter((cell) =>
    legalActionIds.has(cell.id)
  );
  if (legalCells.length === 0) {
    return { rows: 0, cols: 0, cells: [] };
  }

  const rows = legalCells.reduce((max, cell) => Math.max(max, cell.row), 0) + 1;
  const cols = legalCells.reduce((max, cell) => Math.max(max, cell.col), 0) + 1;

  return {
    rows,
    cols,
    cells: legalCells.map((cell) => ({ ...cell, enabled: true })),
  };
}

export function applyLegalActionsToView(
  view: GameView,
  legalIntents: ClientIntent[] | undefined
): GameView {
  return {
    ...view,
    // legalIntents are authoritative; actions must never expose illegal buttons.
    actions: filterActionsByLegalIntents(view.actions, legalIntents),
  };
}
