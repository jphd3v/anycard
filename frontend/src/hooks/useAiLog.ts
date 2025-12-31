import { useAtom, useSetAtom, useAtomValue } from "jotai";
import {
  aiLogAtom,
  aiLogVisibleAtom,
  gameIdAtom,
  seatStatusAtom,
} from "../state";
import { fetchAiLog } from "../socket";

export function useAiLog() {
  const gameId = useAtomValue(gameIdAtom);
  const seats = useAtomValue(seatStatusAtom);
  const setAiLog = useSetAtom(aiLogAtom);
  const [isAiLogVisible, setAiLogVisible] = useAtom(aiLogVisibleAtom);

  const hasAiPlayer = seats.some(
    (s) => s.isAi || s.aiRuntime === "backend" || s.aiRuntime === "frontend"
  );

  async function openAiLog() {
    if (!gameId) return;
    try {
      const entries = await fetchAiLog(gameId);
      setAiLog(entries);
      setAiLogVisible(true);
    } catch (err) {
      console.error("Failed to fetch AI log:", err);
    }
  }

  return {
    openAiLog,
    isAiLogVisible,
    setAiLogVisible,
    hasAiPlayer,
  };
}
