import { useEffect, useState } from "react";
import type { MutableRefObject } from "react";
import type { ParsedRoute } from "../utils/appRouting";
import type { ActiveGameSummary, AvailableGame } from "../state";
import type { GameView, SeatStatus } from "../../../shared/schemas";
import { fetchActiveGames, leaveGame } from "../socket";
import { parseRouteFromLocation } from "../utils/appRouting";

type RouteError =
  | null
  | { kind: "GAME_NOT_FOUND"; gameId?: string; rulesId?: string }
  | {
      kind: "UNKNOWN_ERROR";
      gameId?: string;
      rulesId?: string;
      message?: string;
    };

type LastJoin = {
  gameId: string;
  rulesId: string;
  playerId: string;
  role: "player" | "spectator";
  isGodMode?: boolean;
  roomType?: "demo" | "public" | "private";
};

type SetState<T> = (update: T | ((prev: T) => T)) => void;

type UseRouteHandlersOptions = {
  initialRoute: ParsedRoute | null;
  availableGames: AvailableGame[] | null | undefined;
  defaultRouteRef: MutableRefObject<string | null>;
  gameIdRef: MutableRefObject<string>;
  lastJoinRef: MutableRefObject<LastJoin | null>;
  setGameId: SetState<string>;
  setGameType: SetState<string | null>;
  setRouteError: SetState<RouteError>;
  setJoinedGameId: SetState<string | null>;
  setSeats: SetState<SeatStatus[]>;
  setRoomSeed: SetState<string | null>;
  setView: SetState<GameView | null>;
  setPlayerId: SetState<string | null>;
  setActiveGames: SetState<ActiveGameSummary[]>;
  ensureDefaultGameForType: (rulesId: string) => Promise<void>;
};

export function useRouteHandlers({
  initialRoute,
  availableGames,
  defaultRouteRef,
  gameIdRef,
  lastJoinRef,
  setGameId,
  setGameType,
  setRouteError,
  setJoinedGameId,
  setSeats,
  setRoomSeed,
  setView,
  setPlayerId,
  setActiveGames,
  ensureDefaultGameForType,
}: UseRouteHandlersOptions) {
  const [hasInitializedFromRoute, setHasInitializedFromRoute] = useState(false);

  useEffect(() => {
    if (hasInitializedFromRoute) return;

    if (!initialRoute) {
      setHasInitializedFromRoute(true);
      return;
    }

    const available = availableGames ?? [];
    const hasAvailableGames = available.length > 0;

    // Wait for available games before deciding what to do with the route.
    // This avoids trying to start games for completely unknown types.
    if (!hasAvailableGames) {
      return;
    }

    const isKnownType = available.some((g) => g.id === initialRoute.rulesId);

    if (!isKnownType) {
      // Unknown game rules id → treat as invalid and show the same 404 overlay
      setRouteError({
        kind: "GAME_NOT_FOUND",
        gameId: initialRoute.kind === "explicit" ? initialRoute.gameId : "",
        rulesId: initialRoute.rulesId,
      });

      // Normalize the URL back to root so the user is clearly "in the lobby"
      try {
        window.history.replaceState({}, "", "/");
      } catch (err) {
        console.warn("Failed to replaceState after invalid initial route", err);
      }

      setHasInitializedFromRoute(true);
      return;
    }

    // Valid game rules id routes
    if (initialRoute.kind === "explicit") {
      setGameType(initialRoute.rulesId);
      setGameId(initialRoute.gameId);
      setHasInitializedFromRoute(true);
      return;
    }

    if (initialRoute.kind === "default") {
      defaultRouteRef.current = initialRoute.rulesId;
      void ensureDefaultGameForType(initialRoute.rulesId);
      setHasInitializedFromRoute(true);
    }
  }, [
    availableGames,
    defaultRouteRef,
    ensureDefaultGameForType,
    hasInitializedFromRoute,
    initialRoute,
    setGameId,
    setGameType,
    setRouteError,
  ]);

  useEffect(() => {
    const handlePopState = () => {
      const route = parseRouteFromLocation();

      // If there is no game in the URL → go to lobby
      if (!route) {
        // If we were in a game, leave it
        if (gameIdRef.current) {
          leaveGame();
        }

        setGameId("");
        setGameType(null);
        setPlayerId(null);
        setSeats([]);
        setRoomSeed(null);
        setView(null);
        setJoinedGameId(null);
        lastJoinRef.current = null;
        setRouteError(null);

        // Refresh lobby games
        fetchActiveGames()
          .then(setActiveGames)
          .catch((err) => {
            console.error("Failed to fetch active games after popstate", err);
          });

        return;
      }

      // We have a game route in the URL
      const available = availableGames ?? [];
      const hasAvailableGames = available.length > 0;
      const isKnownType = hasAvailableGames
        ? available.some((g) => g.id === route.rulesId)
        : true; // Don't reject routes until games are loaded

      if (!isKnownType) {
        // Unknown game rules id: → treat as invalid and show error overlay
        if (gameIdRef.current) {
          leaveGame();
        }

        setGameId("");
        setGameType(null);
        setSeats([]);
        setRoomSeed(null);
        setView(null);
        setPlayerId(null);
        setJoinedGameId(null);
        lastJoinRef.current = null;

        setRouteError({
          kind: "GAME_NOT_FOUND",
          gameId: route.kind === "explicit" ? route.gameId : "",
          rulesId: route.rulesId,
        });

        try {
          window.history.replaceState({}, "", "/");
        } catch (err) {
          console.warn("Failed to replaceState after invalid game route", err);
        }

        return;
      }

      if (route.kind === "explicit") {
        defaultRouteRef.current = null;
        setRouteError(null);
        setGameType(route.rulesId);
        setGameId(route.gameId);
        setJoinedGameId(null); // allow auto-join effect to re-run for this game
        return;
      }

      defaultRouteRef.current = route.rulesId;
      setRouteError(null);
      setJoinedGameId(null);
      void ensureDefaultGameForType(route.rulesId);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [
    availableGames,
    defaultRouteRef,
    ensureDefaultGameForType,
    gameIdRef,
    lastJoinRef,
    setActiveGames,
    setGameId,
    setGameType,
    setJoinedGameId,
    setPlayerId,
    setRoomSeed,
    setRouteError,
    setSeats,
    setView,
  ]);
}
