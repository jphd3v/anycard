import type { GameView } from "../../../shared/schemas";

export function hasGameDealt(view: GameView | null): boolean {
  if (
    !view ||
    typeof view.rulesState !== "object" ||
    view.rulesState === null
  ) {
    return false;
  }
  const maybeHasDealt = (view.rulesState as { hasDealt?: unknown }).hasDealt;
  return typeof maybeHasDealt === "boolean" ? maybeHasDealt : false;
}
