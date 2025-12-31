import { useAtomValue } from "jotai";
import {
  gameViewAtom,
  availableGamesAtom,
  isConnectedAtom,
  playerIdAtom,
  seatStatusAtom,
} from "../state";
import { TurnStatusBadge } from "./TurnStatusBadge";
import { LightningIcon, ScoreTableIcon } from "./FloatingWidget";
import { useGameMeta } from "../hooks/useGameMeta";

interface GameHeaderProps {
  onMenuClick: () => void;
  isMenuOpen: boolean;
  onRulesClick: () => void;
  onTurnBadgeClick?: () => void;
  onActionsClick: () => void;
  onScoreboardClick: () => void;
  isActionsOpen: boolean;
  isScoreboardOpen: boolean;
}

export function GameHeader({
  onMenuClick,
  isMenuOpen,
  onRulesClick,
  onTurnBadgeClick,
  onActionsClick,
  onScoreboardClick,
  isActionsOpen,
  isScoreboardOpen,
}: GameHeaderProps) {
  const view = useAtomValue(gameViewAtom);
  const availableGames = useAtomValue(availableGamesAtom);
  const isConnected = useAtomValue(isConnectedAtom);
  const playerId = useAtomValue(playerIdAtom);
  const seats = useAtomValue(seatStatusAtom);
  const gameMeta = useGameMeta(view?.rulesId);

  if (!view) return null;

  const displayName =
    availableGames?.find((g) => g.id === view.rulesId)?.name ??
    view.rulesId ??
    "Game";

  const deckPile = view.piles.find(
    (p) => p.id.toLowerCase() === "deck" || p.label.toLowerCase() === "deck"
  );
  const deckCount = deckPile
    ? (deckPile.totalCards ?? deckPile.cards.length)
    : undefined;

  const hasScoreboards = view.scoreboards.length > 0;
  const hasActions =
    gameMeta?.supportsActions ??
    ((view.actions?.rows ?? 0) > 0 || (view.actions?.cells?.length ?? 0) > 0);

  return (
    <header className="game-header h-14 shrink-0 glass-panel bg-surface-1/80 backdrop-blur-md border-b border-surface-3 flex items-center px-2 sm:px-4 justify-between z-50 relative">
      <div className="header-left flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1 mr-2">
        <button
          id="tutorial-menu-btn"
          onClick={onMenuClick}
          className={`button-base button-icon transition-all duration-300 h-9 w-9 sm:h-11 sm:w-11 shrink-0 ${
            isMenuOpen ? "button-primary rotate-90" : "button-secondary"
          }`}
          aria-label="Menu"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            className="w-5 h-5 sm:w-6 sm:h-6"
          >
            {isMenuOpen ? (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            ) : (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
              />
            )}
          </svg>
        </button>

        <button
          id="tutorial-rules-btn"
          onClick={onRulesClick}
          className="button-base button-icon button-secondary h-9 w-9 sm:h-11 sm:w-11 shrink-0"
          aria-label="Game Rules"
          title="View Rules"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            className="w-5 h-5 sm:w-6 sm:h-6"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"
            />
          </svg>
        </button>

        <div className="header-info flex flex-col ml-1 sm:ml-2 overflow-hidden">
          <h2 className="text-[13px] sm:text-lg font-black text-ink truncate leading-none uppercase tracking-[0.1em] sm:tracking-[0.15em] mb-0.5">
            {displayName}
          </h2>
          {deckCount !== undefined && (
            <span className="text-[8px] sm:text-[9px] text-ink-muted uppercase tracking-wider font-bold truncate opacity-80">
              Deck: {deckCount} {deckCount === 1 ? "card" : "cards"}
            </span>
          )}
        </div>
      </div>

      <div className="header-right flex items-center gap-1.5 sm:gap-3 shrink-0">
        {hasScoreboards && (
          <button
            id="tutorial-scores-btn"
            onClick={onScoreboardClick}
            className={`button-base button-icon transition-all ${
              isScoreboardOpen
                ? "button-primary shadow-inner"
                : "button-secondary"
            }`}
            title="Scoreboard"
          >
            <ScoreTableIcon className="w-5 h-5 sm:w-6 sm:h-6" />
          </button>
        )}

        {hasActions && (
          <button
            id="tutorial-actions-btn"
            onClick={onActionsClick}
            className={`button-base button-icon transition-all relative ${
              isActionsOpen
                ? "bg-indigo-600 text-white shadow-inner"
                : "bg-surface-2 text-indigo-600 hover:bg-indigo-50 border border-indigo-200"
            }`}
            title="Actions"
          >
            <LightningIcon className="w-5 h-5 sm:w-6 sm:h-6" />
            {view.actions.cells.some((c) => c.enabled) && !isActionsOpen && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse border-2 border-surface-1" />
            )}
          </button>
        )}

        <div className="header-divider w-px h-6 bg-surface-3 mx-0.5 sm:mx-1 hidden min-[400px]:block" />

        <TurnStatusBadge
          isConnected={isConnected}
          turnPlayer={view.currentPlayer}
          myPlayerId={playerId}
          seats={view.seats || seats}
          compact={true}
          onClick={onTurnBadgeClick}
        />
      </div>
    </header>
  );
}
