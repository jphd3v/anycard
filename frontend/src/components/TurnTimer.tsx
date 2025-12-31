import { useState, useEffect } from "react";

export function TurnTimer({ currentPlayer }: { currentPlayer: string | null }) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    // Reset timer to 0 whenever the currentPlayer prop changes (new turn)
    setSeconds(0);
    if (!currentPlayer) return;

    const interval = setInterval(() => {
      setSeconds((s) => s + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [currentPlayer]);

  return (
    <span className="font-mono tabular-nums text-[10px] opacity-80 ml-1.5 border-l border-current/20 pl-1.5 normal-case">
      {seconds}s
    </span>
  );
}
