import { useAtomValue, useSetAtom } from "jotai";
import { aiLogAtom, aiLogVisibleAtom, fatalErrorAtom } from "../state";
import { ensureSocket, fetchAiLog } from "../socket";
import { ScrollShadowWrapper } from "./ScrollShadowWrapper";

interface Props {
  gameId: string;
  onExitToSelection?: () => void;
}

export function FatalErrorOverlay({ gameId, onExitToSelection }: Props) {
  const fatalError = useAtomValue(fatalErrorAtom);
  const setFatalError = useSetAtom(fatalErrorAtom);
  const setAiLog = useSetAtom(aiLogAtom);
  const setAiLogVisible = useSetAtom(aiLogVisibleAtom);

  if (!fatalError) return null;

  const { message, source } = fatalError;
  const isAiError = source === "ai";

  async function handleOpenAiLog() {
    try {
      const entries = await fetchAiLog(gameId);
      setAiLog(entries);
      setAiLogVisible(true);
    } catch (err) {
      console.error("Failed to fetch AI log from fatal error overlay", err);
    }
  }

  function handleRetryOrReturn() {
    if (isAiError) {
      const socket = ensureSocket();
      socket.emit("game:retry-ai-turn", { gameId });

      setAiLog((prev) => [
        ...prev,
        {
          gameId,
          turnNumber: 0, // Use 0 if turnNumber is not available in FatalErrorState
          playerId: "unknown", // Use "unknown" if playerId is not available in FatalErrorState
          phase: "execution",
          level: "info",
          message: "Manual AI retry triggered from error overlay",
          timestamp: new Date().toISOString(),
        },
      ]);
    }
    // Clear the error so the overlay hides.
    setFatalError(null);
  }

  function handleReturnToLobby() {
    setFatalError(null);
    if (onExitToSelection) {
      onExitToSelection();
      return;
    }
    window.history.pushState({}, "", "/");
    // Trigger popstate event to make the app handle the route change
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  return (
    <div
      data-testid="fatal-error"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-surface-0/90 backdrop-blur-sm"
    >
      <div className="max-w-md w-full mx-4 rounded-2xl border border-surface-3 bg-surface-1 shadow-xl p-6 flex flex-col gap-4">
        <div>
          <h1 className="text-lg font-semibold text-ink mb-1">
            Something went wrong in this game
          </h1>
          <p className="text-sm text-ink-muted">
            {isAiError
              ? "The AI encountered a fatal error while trying to play its turn. You can retry the AI move or return to Home."
              : "The game engine reported a fatal error. It may not be safe to continue this game."}
          </p>
        </div>

        <ScrollShadowWrapper className="text-xs font-mono bg-surface-2/80 rounded-lg max-h-32">
          <div className="p-3 w-fit min-w-full">{message}</div>
        </ScrollShadowWrapper>

        <div className="flex flex-wrap justify-end gap-3 pt-2">
          {isAiError && (
            <button
              type="button"
              className="button-secondary px-3 py-1.5 text-sm"
              onClick={handleOpenAiLog}
            >
              View AI log
            </button>
          )}
          <button
            type="button"
            data-testid="retry-ai-turn"
            className="button-secondary px-3 py-1.5 text-sm"
            onClick={handleRetryOrReturn}
          >
            {isAiError ? "Retry AI move" : "Return to game"}
          </button>
          <button
            type="button"
            className="button-primary px-3 py-1.5 text-sm"
            onClick={handleReturnToLobby}
          >
            Return to Home
          </button>
        </div>
      </div>
    </div>
  );
}
