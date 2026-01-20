import { useState, useEffect } from "react";
import { fetchGameInfo } from "../../socket";
import type { GameSummary } from "../../state";

interface JoinGameInputProps {
  onJoin: (gameId: string, rulesId?: string) => void;
}

const GAME_ID_LENGTH = 8;
// Based on backend/src/util/game-id.ts ALPHABET
const VALID_CHARS_REGEX = /^[2-9a-zA-Z]+$/;

export function JoinGameInput({ onJoin }: JoinGameInputProps) {
  const [value, setValue] = useState("");
  const [gameInfo, setGameInfo] = useState<GameSummary | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [lastCheckedValue, setLastCheckedValue] = useState("");

  useEffect(() => {
    const trimmed = value.trim();

    // Only search if we have exactly the right number of characters
    // AND they are all valid characters.
    if (trimmed.length !== GAME_ID_LENGTH || !VALID_CHARS_REGEX.test(trimmed)) {
      setGameInfo(null);
      setLastCheckedValue("");
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const info = await fetchGameInfo(trimmed);
        setGameInfo(info);
        setLastCheckedValue(trimmed);
      } finally {
        setIsSearching(false);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [value]);

  const isValueCurrent = value.trim() === lastCheckedValue;

  // Poll for updates if we have a valid game info displayed
  useEffect(() => {
    const gameId = gameInfo?.gameId;
    if (!gameId || !isValueCurrent) return;

    const intervalId = setInterval(async () => {
      if (document.hidden) return;
      try {
        const info = await fetchGameInfo(gameId);
        setGameInfo(info);
      } catch {
        // Ignore errors during polling
      }
    }, 5000);

    return () => clearInterval(intervalId);
  }, [gameInfo?.gameId, isValueCurrent]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (gameInfo) {
      onJoin(gameInfo.gameId, gameInfo.rulesId);
    } else if (value.trim()) {
      onJoin(value.trim());
    }
  };

  return (
    <div className="px-4 mb-8">
      <form onSubmit={handleSubmit} className="relative z-10">
        <div className="flex flex-col items-center gap-6">
          <div className="relative group w-full max-w-[320px]">
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Type or paste Game ID to join"
              maxLength={GAME_ID_LENGTH}
              className="w-full px-4 py-3 bg-surface-1 border border-surface-3 rounded-xl text-ink font-mono text-center text-sm placeholder:text-ink-muted/50 placeholder:font-sans focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 shadow-sm transition-all"
            />
            {isSearching && (
              <div className="absolute right-4 top-1/2 -translate-y-1/2">
                <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              </div>
            )}
          </div>

          {gameInfo && isValueCurrent && (
            <div className="w-full max-w-[340px] p-5 bg-surface-1 border border-primary/20 rounded-2xl shadow-xl animate-in fade-in slide-in-from-top-4 duration-300">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="font-bold text-base text-ink leading-tight">
                    {gameInfo.gameName}
                  </h3>
                  <p className="text-2xs text-ink-muted font-mono uppercase tracking-widest mt-0.5">
                    Room: {gameInfo.gameId}
                  </p>
                </div>
                <div className="px-2 py-0.5 bg-primary/10 rounded text-2xs font-black text-primary uppercase tracking-tighter border border-primary/20">
                  {gameInfo.roomType}
                </div>
              </div>

              <div className="flex items-center gap-4 text-xs text-ink-muted mb-5">
                <div className="flex items-center gap-1">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="w-3.5 h-3.5 text-primary/70"
                  >
                    <path d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" />
                  </svg>
                  <span className="font-medium whitespace-nowrap">
                    {gameInfo.numOccupiedSeats} / {gameInfo.numSeats} Seats
                  </span>
                </div>
                {gameInfo.numSpectators > 0 && (
                  <div className="flex items-center gap-1">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className="w-3.5 h-3.5 text-ink-muted/60"
                    >
                      <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
                      <path
                        fillRule="evenodd"
                        d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span className="whitespace-nowrap">
                      {gameInfo.numSpectators} Spectators
                    </span>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => onJoin(gameInfo.gameId, gameInfo.rulesId)}
                className="w-full button-base button-primary py-2.5 rounded-xl text-sm font-bold shadow-lg hover:shadow-primary/20 active:scale-[0.97] transition-all"
              >
                Join Room
              </button>
            </div>
          )}

          {value.trim().length === GAME_ID_LENGTH &&
            isValueCurrent &&
            !gameInfo &&
            !isSearching && (
              <div className="flex flex-col items-center gap-2 p-4 bg-red-50/80 border border-red-200 rounded-2xl animate-in fade-in zoom-in-95 duration-200">
                <div className="flex items-center gap-2 text-red-600">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    className="w-5 h-5"
                  >
                    <path
                      fillRule="evenodd"
                      d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.401 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="font-bold text-sm">Game Not Found</span>
                </div>
                <p className="text-2xs text-red-500/80 text-center max-w-[200px]">
                  We couldn't find a game with ID{" "}
                  <span className="font-mono font-bold">"{value.trim()}"</span>.
                  Please check the ID and try again.
                </p>
              </div>
            )}
        </div>
      </form>
    </div>
  );
}
