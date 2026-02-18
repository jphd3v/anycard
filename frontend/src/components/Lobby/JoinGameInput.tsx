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
      } catch {
        // The user may be offline or the backend may be restarting.
        // Keep the input usable without surfacing noisy console errors.
        setGameInfo(null);
        setLastCheckedValue("");
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
    <div className="px-4 mb-6">
      <form onSubmit={handleSubmit} className="relative z-10">
        <div className="flex flex-col items-center gap-4">
          <div className="w-full max-w-[680px]">
            <div className="relative group mx-auto w-full animate-in fade-in duration-150">
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
          </div>
        </div>
      </form>
    </div>
  );
}
