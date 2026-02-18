import { useEffect } from "react";
import type { GameView } from "../../../shared/schemas";
import type { RecentGameEntry } from "../state";
import { watchGame } from "../socket";

type RouteError =
  | null
  | { kind: "GAME_NOT_FOUND"; gameId?: string; rulesId?: string }
  | {
      kind: "UNKNOWN_ERROR";
      gameId?: string;
      rulesId?: string;
      message?: string;
    };

type SetState<T> = (update: T | ((prev: T) => T)) => void;

type UseAutoJoinOptions = {
  gameId: string;
  routeError: RouteError;
  joinedGameId: string | null;
  recentGames: RecentGameEntry[];
  rulesId: string | null;
  view: GameView | null;
  playerId: string | null;
  setPlayerId: SetState<string | null>;
  setJoinedGameId: SetState<string | null>;
  rememberAndJoin: (
    targetGameId: string,
    targetRulesId: string,
    targetPlayerId: string,
    role: "player" | "spectator",
    opts?: { isGodMode?: boolean },
    meta?: { roomType?: "demo" | "public" | "private" }
  ) => void;
};

export function useAutoJoin({
  gameId,
  routeError,
  joinedGameId,
  recentGames,
  rulesId,
  view,
  playerId,
  setPlayerId,
  setJoinedGameId,
  rememberAndJoin,
}: UseAutoJoinOptions) {
  useEffect(() => {
    // No game selected or we already know the route is invalid → do nothing
    if (!gameId || routeError) return;

    // We already joined this gameId (once) → do not auto-join again
    if (joinedGameId === gameId) {
      return;
    }

    // Decide who to join as
    let pid = "";
    const role: "player" | "spectator" = "player";
    const recentEntry = recentGames.find((entry) => entry.gameId === gameId);
    const rulesIdForJoin = rulesId ?? "";
    const isDefaultRoute =
      !!rulesIdForJoin && window.location.pathname === `/${rulesIdForJoin}`;

    if (recentEntry?.lastRole === "player") {
      pid = recentEntry.lastPlayerId;
      if (playerId !== pid) {
        setPlayerId(pid);
      }

      rememberAndJoin(gameId, rulesIdForJoin, pid, role, undefined, {
        roomType: isDefaultRoute ? "demo" : undefined,
      });
      return;
    }

    if (view) {
      return;
    }

    if (playerId !== null) {
      setPlayerId(null);
    }
    setJoinedGameId(gameId);
    watchGame(gameId);
  }, [
    gameId,
    joinedGameId,
    playerId,
    recentGames,
    rememberAndJoin,
    routeError,
    rulesId,
    setJoinedGameId,
    setPlayerId,
    view,
  ]);
}
