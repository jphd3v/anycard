import { TurnTimer } from "./TurnTimer";
import type { SeatStatus, SeatView } from "../../../shared/schemas";

interface TurnStatusBadgeProps {
  isConnected: boolean;
  turnPlayer: string | null;
  myPlayerId: string | null;
  seats: (SeatStatus | SeatView)[];
  onClick?: () => void;
  compact?: boolean;
  className?: string;
}

export function TurnStatusBadge({
  isConnected,
  turnPlayer,
  myPlayerId,
  seats,
  onClick,
  compact = false,
  className = "",
}: TurnStatusBadgeProps) {
  const isMyTurn = turnPlayer === myPlayerId;
  const currentSeat = seats.find((s) =>
    "playerId" in s ? s.playerId === turnPlayer : s.seatId === turnPlayer
  );
  const turnName = currentSeat?.name ?? turnPlayer ?? "";
  const aiRuntime =
    currentSeat && "aiRuntime" in currentSeat
      ? currentSeat.aiRuntime
      : undefined;
  const isAiControlledByYou =
    currentSeat && "isAiControlledByYou" in currentSeat
      ? currentSeat.isAiControlledByYou
      : undefined;
  const isOpponentTurn = !isMyTurn && !!turnPlayer;

  // -- Style Logic --
  let innerBgClass = "bg-surface-1 text-ink-muted";
  let borderColor = "var(--color-surface-3)";

  let statusText = turnName || "Waiting";
  let statusLabel: string | null = null; // For AI runtime info
  let statusIcon: JSX.Element | null = null;
  const statusSubtext: JSX.Element | null = null;
  let animationClass = "";

  const showTimer = isConnected && !!turnPlayer && !isMyTurn;

  if (!isConnected) {
    innerBgClass = "bg-red-50 text-red-600";
    borderColor = "#ef4444"; // red-500
    statusText = "Offline";
  } else if (isMyTurn) {
    innerBgClass = "bg-emerald-50 text-emerald-700";
    borderColor = "#10b981"; // emerald-500
    statusText = "Your Turn";
    animationClass = "animate-pulse-slow";
  } else if (aiRuntime === "backend") {
    innerBgClass = "bg-indigo-50 text-indigo-700";
    borderColor = "#6366f1"; // indigo-500
    statusText = turnName;
    statusLabel = compact ? "AI" : "AI (server)";
    statusIcon = (
      <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
    );
    animationClass = "animate-pulse-slow";
  } else if (aiRuntime === "frontend" && isAiControlledByYou) {
    innerBgClass = "bg-indigo-50 text-indigo-700";
    borderColor = "#6366f1"; // indigo-500
    statusText = turnName;
    statusLabel = compact ? "AI" : "AI (browser)";
    statusIcon = (
      <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
    );
    animationClass = "animate-pulse-slow";
  } else if (aiRuntime === "frontend" && !isAiControlledByYou) {
    innerBgClass = "bg-indigo-50 text-indigo-700";
    borderColor = "#6366f1"; // indigo-500
    statusText = turnName;
    statusLabel = compact ? "AI" : "AI (remote)";
    statusIcon = (
      <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
    );
    animationClass = "animate-pulse-slow";
  } else if (isOpponentTurn) {
    innerBgClass = "bg-amber-50 text-amber-800";
    borderColor = "#f59e0b"; // amber-500
    statusText = turnName || "Opponent Turn";
    statusIcon = (
      <svg
        className="w-3.5 h-3.5 opacity-60"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={2.5}
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    );
    animationClass = "animate-pulse-slow";
  }

  // Construct the conic gradient: transparent -> color -> transparent
  const gradientStyle = {
    backgroundImage: `conic-gradient(from 0deg, transparent 0deg, ${borderColor} 360deg)`,
  };

  const isClickable = !!onClick;

  return (
    <div
      id="tutorial-log-btn"
      className={`
        relative group pointer-events-auto flex items-center justify-center p-[2px] rounded-full overflow-hidden shadow-sm transition-transform duration-200
        ${isClickable ? "cursor-pointer hover:scale-105 active:scale-95" : "cursor-default"}
        ${animationClass}
        ${className}
      `}
      onClick={onClick}
      role={isClickable ? "button" : undefined}
      aria-label={isClickable ? "Show game log" : undefined}
    >
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[500%] aspect-square animate-spin"
        style={{
          ...gradientStyle,
          animationDuration: "3s",
          animationTimingFunction: "linear",
        }}
      />

      <div
        className={`relative h-full w-full ${compact ? "px-2 py-1 text-[0.6rem]" : "px-3 py-1.5 text-[0.625rem]"} rounded-full font-bold uppercase tracking-wide flex items-center gap-1.5 flex-shrink-0 ${innerBgClass}`}
      >
        {statusIcon}
        <span className="truncate max-w-[60px] sm:max-w-[100px]">
          {statusText}
        </span>
        {statusLabel && (
          <span
            className={`${compact ? "text-[8px] px-1" : "text-xs px-2"} rounded py-0.5 bg-slate-700 text-slate-100`}
          >
            {statusLabel}
          </span>
        )}
        {statusSubtext}
        {showTimer && <TurnTimer currentPlayer={turnPlayer} />}
      </div>
    </div>
  );
}
