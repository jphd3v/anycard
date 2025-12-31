import type { Pile } from "../../shared/schemas.js";

/**
 * Returns true if the contents of this pile are visible to the given viewer.
 */
export function isPileVisibleToPlayer(pile: Pile, viewerId: string): boolean {
  if (viewerId === "__god__") {
    return true;
  }

  return (
    pile.visibility === "public" ||
    (pile.visibility === "owner" && pile.ownerId === viewerId)
  );
}
