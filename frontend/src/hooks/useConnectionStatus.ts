import { useEffect, useRef } from "react";
import { connect, setupConnectionHandlers } from "../socket";

type SetState<T> = (update: T | ((prev: T) => T)) => void;

type UseConnectionStatusOptions = {
  isConnected: boolean;
  setIsConnected: SetState<boolean>;
  attemptRejoin: () => void;
};

export function useConnectionStatus({
  isConnected,
  setIsConnected,
  attemptRejoin,
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
      attemptRejoin();
      wasDisconnectedRef.current = false;
    }
  }, [attemptRejoin, isConnected]);

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
