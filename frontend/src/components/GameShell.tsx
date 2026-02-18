import type {
  CardView,
  GameView,
  SeatStatus,
  SeatView,
} from "../../../shared/schemas";
import { GameHUD } from "./GameHUD";
import { GameHeader } from "./GameHeader";
import { GameRoot } from "./GameRoot";
import { FloatingWidget } from "./FloatingWidget";
import { FatalErrorOverlay } from "./FatalErrorOverlay";
import { WinnerOverlay } from "./WinnerOverlay";
import {
  FloatingActionOverlay,
  type FloatingActionItem,
} from "./FloatingActionOverlay";
import { sfx } from "../utils/audio";

type GameShellProps = {
  gameId: string;
  view: GameView;
  playerId: string;
  seats: SeatStatus[];
  isConnected: boolean;
  suppressStartOverlay: boolean;
  holdStartOverlay: boolean;
  isStartGameBusy: boolean;
  onStartGame: (isNextRound: boolean) => void;
  onSkipStartGameAnimations: () => void;
  overrideStartOverlayIsNextRound: boolean | null;
  highlightedWidget: "actions" | "scoreboards" | null;
  isAnyEndOverlayVisible: boolean;
  headerTransitionCards: CardView[];
  isMenuOpen: boolean;
  onMenuClick: () => void;
  onRulesClick: () => void;
  onTurnBadgeClick: () => void;
  isActionsOpen: boolean;
  isScoreboardOpen: boolean;
  onActionsClick: () => void;
  onScoreboardClick: () => void;
  onActionsToggle: SetState<boolean>;
  onScoreboardToggle: SetState<boolean>;
  announcementItems: FloatingActionItem[];
  onAnnouncementComplete: (id: string) => void;
  onExitToSelection: () => void;
  winnerLabel?: string;
  onRestart: () => void;
  onExit: () => void;
  onExitSeat: () => void;
  onAboutClick: () => void;
  onActionIntent: (action: string) => void;
};

type SetState<T> = (update: T | ((prev: T) => T)) => void;

export function GameShell({
  gameId,
  view,
  playerId,
  seats,
  isConnected,
  suppressStartOverlay,
  holdStartOverlay,
  isStartGameBusy,
  onStartGame,
  onSkipStartGameAnimations,
  overrideStartOverlayIsNextRound,
  highlightedWidget,
  isAnyEndOverlayVisible,
  headerTransitionCards,
  isMenuOpen,
  onMenuClick,
  onRulesClick,
  onTurnBadgeClick,
  isActionsOpen,
  isScoreboardOpen,
  onActionsClick,
  onScoreboardClick,
  onActionsToggle,
  onScoreboardToggle,
  announcementItems,
  onAnnouncementComplete,
  onExitToSelection,
  winnerLabel,
  onRestart,
  onExit,
  onExitSeat,
  onAboutClick,
  onActionIntent,
}: GameShellProps) {
  const actionsDisabled = Boolean(
    view.seats?.find((s: SeatView) => s.seatId === playerId)?.aiRuntime !==
    "none"
  );

  return (
    <div className="game-layout flex flex-col h-full w-full overflow-hidden">
      <GameHeader
        className={isAnyEndOverlayVisible ? "z-[1100]" : "z-50"}
        isOverlayActive={isAnyEndOverlayVisible}
        transitionCards={headerTransitionCards}
        onMenuClick={onMenuClick}
        isMenuOpen={isMenuOpen}
        onRulesClick={onRulesClick}
        onTurnBadgeClick={onTurnBadgeClick}
        onActionsClick={onActionsClick}
        onScoreboardClick={onScoreboardClick}
        isActionsOpen={isActionsOpen}
        isScoreboardOpen={isScoreboardOpen}
      />
      <div className="flex-1 relative overflow-hidden">
        <GameRoot
          view={view}
          playerId={playerId}
          disabled={!isConnected}
          suppressStartOverlay={suppressStartOverlay}
          holdStartOverlay={holdStartOverlay}
          isStartGameBusy={isStartGameBusy}
          onStartGame={onStartGame}
          onSkipStartGameAnimations={onSkipStartGameAnimations}
          overrideStartOverlayIsNextRound={overrideStartOverlayIsNextRound}
          highlightedWidget={highlightedWidget}
        />
        <FloatingActionOverlay
          actions={announcementItems}
          onComplete={onAnnouncementComplete}
          durationMs={2800}
        />
        <FatalErrorOverlay
          gameId={gameId}
          onExitToSelection={onExitToSelection}
        />
        <WinnerOverlay
          winnerId={view.winner}
          winnerLabel={winnerLabel}
          seats={seats}
          onRestart={onRestart}
          onExit={onExit}
        />
        <GameHUD
          gameId={gameId}
          onExit={onExitSeat}
          onReset={onRestart}
          onAboutClick={onAboutClick}
        />
        <div
          className={`header-floating-panel fixed top-16 right-2 sm:right-4 pointer-events-none flex flex-col items-end ${
            isAnyEndOverlayVisible ? "z-[1110]" : "z-[70]"
          }`}
        >
          <div className="header-panel-slot" data-open={isScoreboardOpen}>
            <FloatingWidget
              config={{ widget: "scoreboards", position: "top-right" }}
              view={view}
              onActionClick={() => {}}
              isOpen={isScoreboardOpen}
              onToggle={onScoreboardToggle}
              showTrigger={false}
              className="relative flex flex-col items-end"
              panelClassName="header-protrude w-72 sm:w-80 max-h-[70vh] overflow-y-auto rounded-xl shadow-floating bg-surface-1/95 backdrop-blur-md border border-surface-3 animate-in fade-in zoom-in-95 duration-200"
            />
          </div>

          <div className="header-panel-slot" data-open={isActionsOpen}>
            <FloatingWidget
              config={{ widget: "actions", position: "top-right" }}
              view={view}
              onActionClick={(action) => {
                sfx.playClick();
                onActionIntent(action);
              }}
              actionsDisabled={actionsDisabled}
              isOpen={isActionsOpen}
              onToggle={onActionsToggle}
              showTrigger={false}
              className="relative flex flex-col items-end"
              panelClassName="header-protrude w-72 sm:w-80 max-h-[70vh] overflow-y-auto rounded-xl shadow-floating bg-surface-1/95 backdrop-blur-md border border-surface-3 animate-in fade-in zoom-in-95 duration-200"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
