export type ParsedRoute =
  | { kind: "explicit"; rulesId: string; gameId: string }
  | { kind: "default"; rulesId: string }
  | null;

export function parseRouteFromLocation(
  location: Location = window.location
): ParsedRoute {
  const path = location.pathname.replace(/^\/+/, "");
  if (!path) return null;

  const [rulesId, gameId] = path.split("/");
  if (!rulesId) return null;

  if (!gameId) {
    return { kind: "default", rulesId };
  }

  return { kind: "explicit", rulesId, gameId };
}
