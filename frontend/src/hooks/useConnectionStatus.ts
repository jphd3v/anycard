import { useEffect, useRef } from "react";
import { connect, setupConnectionHandlers, fetchGameInfo } from "../socket";

type SetState<T> = (update: T | ((prev: T) => T)) => void;

type UseConnectionStatusOptions = {
  isConnected: boolean;
  setIsConnected: SetState<boolean>;
  attemptRejoin: () => void;
  gameId?: string;
  onGameNotFound?: () => void;
};

export function useConnectionStatus({
  isConnected,
  setIsConnected,
  attemptRejoin,
  gameId,
  onGameNotFound,
}: UseConnectionStatusOptions) {
  const wasDisconnectedRef = useRef(false);

  useEffect(() => {
    return setupConnectionHandlers(
      () => setIsConnected(true),
      () => setIsConnected(false)
    );
  }, [setIsConnected]);

  useEffect(() => {
    if (!isConnected) {
      wasDisconnectedRef.current = true;
      return;
    }
    if (wasDisconnectedRef.current) {
      // On reconnection, first verify the game still exists if we're in a game
      if (gameId && onGameNotFound) {
        fetchGameInfo(gameId)
          .then((gameInfo) => {
            if (!gameInfo) {
              // Game no longer exists on server
              console.warn(
                `Game ${gameId} not found on server after reconnection`
              );
              onGameNotFound();
            } else {
              // Game exists, proceed with rejoin
              attemptRejoin();
            }
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            const isTransientNetworkError =
              /Failed to fetch|ERR_INTERNET_DISCONNECTED|NetworkError|Load failed/i.test(
                message
              );
            if (isTransientNetworkError) {
              console.warn(
                "Transient network error while verifying game existence after reconnection."
              );
            } else {
              console.error("Failed to verify game existence:", err);
            }
            // On fetch error, still attempt rejoin and let the join handler deal with it
            attemptRejoin();
          });
      } else {
        attemptRejoin();
      }
      wasDisconnectedRef.current = false;
    }
  }, [attemptRejoin, isConnected, gameId, onGameNotFound]);

  useEffect(() => {
    const handleOnline = () => {
      setIsConnected(true);
      connect();
    };
    const handleOffline = () => {
      setIsConnected(false);
    };

    if (!navigator.onLine) {
      setIsConnected(false);
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [setIsConnected]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        connect();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);
}
