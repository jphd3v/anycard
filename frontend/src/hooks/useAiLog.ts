import { useAtom, useSetAtom, useAtomValue } from "jotai";
import {
  aiLogAtom,
  aiHistoricalUnavailableAtom,
  aiLogVisibleAtom,
  gameLogAtom,
  gameIdAtom,
  seatStatusAtom,
} from "../state";
import { fetchAiLog, fetchGameLog } from "../socket";

export function useAiLog() {
  const gameId = useAtomValue(gameIdAtom);
  const seats = useAtomValue(seatStatusAtom);
  const setAiLog = useSetAtom(aiLogAtom);
  const setAiHistoricalUnavailable = useSetAtom(aiHistoricalUnavailableAtom);
  const setGameLog = useSetAtom(gameLogAtom);
  const [isAiLogVisible, setAiLogVisible] = useAtom(aiLogVisibleAtom);

  const hasAiPlayer = seats.some(
    (s) => s.isAi || s.aiRuntime === "backend" || s.aiRuntime === "frontend"
  );

  async function openAiLog() {
    if (!gameId) return;
    try {
      const [gameEntries, aiEntries] = await Promise.all([
        fetchGameLog(gameId),
        fetchAiLog(gameId),
      ]);
      setGameLog(gameEntries);
      setAiLog(aiEntries.entries);
      setAiHistoricalUnavailable(aiEntries.historicalUnavailable);
      setAiLogVisible(true);
    } catch (err) {
      console.error("Failed to fetch game log:", err);
    }
  }

  async function refreshGameLog() {
    if (!gameId) return;
    try {
      const entries = await fetchGameLog(gameId);
      setGameLog(entries);
    } catch (err) {
      console.error("Failed to refresh game log:", err);
    }
  }

  return {
    openAiLog,
    refreshGameLog,
    isAiLogVisible,
    setAiLogVisible,
    hasAiPlayer,
  };
}
