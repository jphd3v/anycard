import { useState } from "react";
import type { SeatStatus } from "../../../shared/schemas";
import { Overlay } from "./Overlay";

interface WinnerOverlayProps {
  winnerId: string | null;
  seats: SeatStatus[];
  onRestart: () => void;
  onExit: () => void;
}

export function WinnerOverlay({
  winnerId,
  seats,
  onRestart,
  onExit,
}: WinnerOverlayProps) {
  const [isMinimized, setIsMinimized] = useState(false);

  if (!winnerId) return null;

  const seat = seats.find((s) => s.playerId === winnerId);
  const winnerLabel = seat?.name || winnerId;

  return (
    <Overlay
      translucent={true}
      blurred={false}
      className={
        isMinimized
          ? "items-end justify-center pb-8 pointer-events-none"
          : "items-end justify-center pb-4 px-4 sm:px-6"
      }
      lockScroll={!isMinimized}
    >
      {isMinimized ? (
        <button
          onClick={() => setIsMinimized(false)}
          className="pointer-events-auto px-4 py-2 rounded-full shadow-floating border border-surface-3 bg-surface-2/80 flex items-center gap-2 transition-all hover:scale-105 active:scale-95"
        >
          <span className="text-xs font-bold text-ink">
            Winner: {winnerLabel}
          </span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2.5}
            stroke="currentColor"
            className="w-4 h-4"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4.5 15.75l7.5-7.5 7.5 7.5"
            />
          </svg>
        </button>
      ) : (
        <div
          role="dialog"
          aria-label="Game finished"
          className="w-full max-w-3xl rounded-2xl border border-surface-3 bg-surface-2 shadow-floating px-4 py-3 sm:px-6 sm:py-4 pointer-events-auto relative"
        >
          <button
            onClick={() => setIsMinimized(true)}
            className="absolute top-2 right-2 sm:top-4 sm:right-4 p-2 text-ink-muted hover:text-ink hover:bg-surface-3 rounded-full transition-colors z-30"
            title="Minimize"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              className="w-6 h-6"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 8.25l-7.5 7.5-7.5-7.5"
              />
            </svg>
          </button>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pr-8 sm:pr-12">
            <div className="text-center sm:text-left">
              <div className="text-sm font-bold text-ink">
                Winner: {winnerLabel}
              </div>
              <div className="text-xs text-ink-muted">
                This hand is finished. What would you like to do next?
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 w-full sm:w-auto">
              <button
                type="button"
                data-testid="reset-game"
                onClick={onRestart}
                className="button-base button-primary flex-1 px-5 py-2.5 text-sm"
              >
                Restart
              </button>
              <button
                type="button"
                onClick={onExit}
                className="button-base button-secondary flex-1 px-5 py-2.5 text-sm text-ink"
              >
                Back to Home
              </button>
            </div>
          </div>
        </div>
      )}
    </Overlay>
  );
}
