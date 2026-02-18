import { useCallback, useRef, useEffect } from "react";
import { useSetAtom, useAtomValue } from "jotai";
import {
  statusMessageAtom,
  toastAutoCloseEnabledAtom,
  type StatusMessage,
  type StatusTone,
  type StatusSource,
} from "../state";

const DEFAULT_TOAST_DURATION_MS = 3750;

/**
 * Shared toast hook that manages status messages with automatic cleanup.
 * This consolidates the toast logic previously duplicated across components.
 */
export function useToast() {
  const addStatusMessage = useSetAtom(statusMessageAtom);
  const toastAutoCloseEnabled = useAtomValue(toastAutoCloseEnabledAtom);
  const activeTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Cleanup all timers on unmount
  useEffect(() => {
    const timers = activeTimersRef.current;
    return () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  const showToast = useCallback(
    (
      message: string,
      tone: StatusTone = "success",
      source: StatusSource = "app",
      durationMs: number = DEFAULT_TOAST_DURATION_MS
    ) => {
      const id = Date.now() + Math.random();
      const newMessage: StatusMessage = { id, message, tone, source };

      // Prepend (newest first) so it appears at the visual top of the stack
      addStatusMessage((prev) => [newMessage, ...prev]);

      if (toastAutoCloseEnabled) {
        const timer = setTimeout(() => {
          addStatusMessage((prev) => prev.filter((m) => m.id !== id));
          activeTimersRef.current.delete(timer);
        }, durationMs);
        activeTimersRef.current.add(timer);
      }

      return id;
    },
    [addStatusMessage, toastAutoCloseEnabled]
  );

  const removeToast = useCallback(
    (id: number) => {
      addStatusMessage((prev) => prev.filter((m) => m.id !== id));
    },
    [addStatusMessage]
  );

  return { showToast, removeToast };
}
