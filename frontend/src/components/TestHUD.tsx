import { useEffect } from "react";
import { useAtomValue } from "jotai";
import {
  gameIdAtom,
  isConnectedAtom,
  playerIdAtom,
  rulesIdAtom,
  selectedCardAtom,
} from "../state";
import { getTestContextLabel, isTestMode } from "../utils/testMode";
import { restartGame } from "../socket";

export function TestHUD() {
  const testMode = isTestMode();
  const gameId = useAtomValue(gameIdAtom);
  const playerId = useAtomValue(playerIdAtom);
  const rulesId = useAtomValue(rulesIdAtom);
  const isConnected = useAtomValue(isConnectedAtom);
  const selectedCard = useAtomValue(selectedCardAtom);
  const ctx = getTestContextLabel();

  const seatId = playerId?.startsWith("spectator") ? "spectator" : playerId;

  useEffect(() => {
    if (!testMode) {
      return;
    }
    const titleParts = [
      "anycard",
      ctx ? `[${ctx}]` : null,
      rulesId ?? null,
      seatId ?? null,
      gameId ? `#${gameId.slice(0, 8)}` : null,
    ].filter(Boolean);
    document.title = titleParts.join(" ");
  }, [ctx, gameId, rulesId, seatId, testMode]);

  if (!testMode) {
    return null;
  }

  const handleReset = () => {
    if (!gameId) return;
    restartGame(gameId);
  };

  return (
    <div
      data-testid="testhud"
      className="fixed top-0 left-0 right-0 z-[1000] bg-blue-900/95 backdrop-blur-sm text-white text-xs p-2 flex items-center justify-between gap-4 border-b border-blue-700"
    >
      <div className="flex items-center gap-4">
        <div>
          <span className="text-blue-200">Rules:</span>{" "}
          <span data-testid="testhud:rulesId" className="font-mono">
            {rulesId || "N/A"}
          </span>
        </div>

        <div>
          <span className="text-blue-200">Ctx:</span>{" "}
          <span data-testid="testhud:ctx" className="font-mono">
            {ctx || "N/A"}
          </span>
        </div>

        <div>
          <span className="text-blue-200">Game:</span>{" "}
          <span data-testid="testhud:gameId" className="font-mono">
            {gameId || "N/A"}
          </span>
        </div>

        <div>
          <span className="text-blue-200">Seat:</span>{" "}
          <span data-testid="testhud:seatId" className="font-mono">
            {seatId || "N/A"}
          </span>
        </div>

        <div>
          <span className="text-blue-200">Selected:</span>{" "}
          <span data-testid="testhud:selected" className="font-mono">
            {selectedCard
              ? `${selectedCard.fromPileId}:${selectedCard.cardId}`
              : "none"}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          data-testid="testhud:reset"
          onClick={handleReset}
          disabled={!gameId}
          className="px-2 py-1 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed rounded text-xs"
        >
          Reset
        </button>
        <span>
          <span className="text-blue-200">Status:</span>{" "}
          <span
            data-testid="testhud:connected"
            className={`font-semibold ${
              isConnected ? "text-green-300" : "text-red-300"
            }`}
          >
            {isConnected ? "CONNECTED" : "DISCONNECTED"}
          </span>
        </span>
      </div>
    </div>
  );
}
