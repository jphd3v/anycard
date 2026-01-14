import { useAtomValue } from "jotai";
import { useEffect, useState, useLayoutEffect } from "react";
import { allSeatsJoinedAtom, allSeatsAutomatedAtom } from "../state";
import { sendActionIntent } from "../socket";
import type { GameView } from "../../../shared/schemas";
import { FullScreenMessage } from "./FullScreenMessage";
import { useMenuControls } from "../hooks/useMenuControls";
import { useGameMeta } from "../hooks/useGameMeta";

interface StartGameOverlayProps {
  view: GameView;
  playerId: string;
  suppress?: boolean;
}

/**
 * A small helper to highlight a specific element on the screen with a red numbered badge.
 */
function TutorialHighlight({
  targetId,
  label,
  isVisible,
  yOffset = 0,
}: {
  targetId: string;
  label: string;
  isVisible: boolean;
  yOffset?: number;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (!isVisible) return;

    const el = document.getElementById(targetId);
    if (!el) return;

    const update = () => {
      const newRect = el.getBoundingClientRect();
      setRect((prev) => {
        if (
          prev &&
          prev.top === newRect.top &&
          prev.left === newRect.left &&
          prev.width === newRect.width &&
          prev.height === newRect.height
        ) {
          return prev;
        }
        return newRect;
      });
    };

    update();

    // Re-check after a short delay to catch layout settling (e.g. flexbox)
    const timeoutId = setTimeout(update, 100);

    const observer = new ResizeObserver(update);
    observer.observe(el);
    // Also observe body for global layout shifts
    observer.observe(document.body);

    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);

    return () => {
      clearTimeout(timeoutId);
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [targetId, isVisible]);

  if (!rect || !isVisible) return null;

  return (
    <div
      className="fixed z-[100] pointer-events-none transition-all duration-500 animate-in fade-in zoom-in-90"
      style={{
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      }}
    >
      {/* Thin focus rectangle */}
      <div className="absolute inset-0 border border-red-500/40 rounded-lg" />

      {/* Label: Positioned strictly BELOW the target button */}
      <div
        className="absolute left-1/2 -translate-x-1/2 animate-subtle-bounce"
        style={{ top: `calc(100% + 4px + ${yOffset}px)` }}
      >
        <div className="whitespace-nowrap bg-red-600 text-[9px] md:text-[11px] font-black text-white px-2 py-0.5 rounded uppercase tracking-tighter shadow-md ring-1 ring-white">
          {label}
        </div>
      </div>
    </div>
  );
}

export function StartGameOverlay({
  view,
  playerId,
  suppress = false,
}: StartGameOverlayProps) {
  const allSeatsJoined = useAtomValue(allSeatsJoinedAtom);
  const allSeatsAutomated = useAtomValue(allSeatsAutomatedAtom);
  const { closeAll } = useMenuControls();
  const gameMeta = useGameMeta(view?.rulesId);

  // Detect if we are in a cramped landscape orientation
  const [isShortScreen, setIsShortScreen] = useState(window.innerHeight < 450);

  useEffect(() => {
    const handleResize = () => setIsShortScreen(window.innerHeight < 450);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  if (suppress) return null;

  const isSpectator = view.metadata?.role === "spectator";
  const canSpectatorStart = isSpectator && allSeatsAutomated;

  const hasDealt =
    typeof view.rulesState === "object" &&
    view.rulesState !== null &&
    "hasDealt" in view.rulesState &&
    typeof (view.rulesState as { hasDealt?: boolean }).hasDealt === "boolean"
      ? (view.rulesState as { hasDealt?: boolean }).hasDealt
      : false;

  const isNextRound = (() => {
    const rulesState =
      view.rulesState && typeof view.rulesState === "object"
        ? (view.rulesState as Record<string, unknown>)
        : null;
    if (!rulesState) return false;

    const isNumber = (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value);

    const hasNonZeroNumbers = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      return Object.values(value as Record<string, unknown>).some(
        (entry) => isNumber(entry) && entry !== 0
      );
    };

    return (
      (isNumber(rulesState.dealNumber) && rulesState.dealNumber > 0) ||
      (isNumber(rulesState.roundNumber) && rulesState.roundNumber > 1) ||
      (isNumber(rulesState.handNumber) && rulesState.handNumber > 1) ||
      hasNonZeroNumbers(rulesState.scores) ||
      hasNonZeroNumbers(rulesState.gameScore) ||
      hasNonZeroNumbers(rulesState.lastHandScore)
    );
  })();

  const showTutorial = !isNextRound;

  const shouldShow =
    !!view.gameId && !!playerId && allSeatsJoined && !hasDealt && !view.winner;

  if (!shouldShow) return null;

  const handleClick = () => {
    // Convention: most games treat this as "deal & start"
    sendActionIntent(view.gameId, playerId, "start-game");
    closeAll(500, { skipActions: true });
  };

  const startLabel = isNextRound ? "next round" : "game";
  const continuationLabel = isNextRound ? "continue" : "begin";

  const mainDescription = (() => {
    if (isSpectator && !canSpectatorStart) {
      return `The room is full. A seated player must start the ${startLabel} to deal the cards and ${continuationLabel}.`;
    }
    if (isSpectator && canSpectatorStart) {
      return `This is a fully-automated (AI-only) room. You can start the ${startLabel} to deal the cards and ${continuationLabel}.`;
    }
    return `Any player can start the ${startLabel} to deal the cards and ${continuationLabel}.`;
  })();

  const hasScoreboards = view.scoreboards.length > 0;
  const hasActions =
    gameMeta?.supportsActions ??
    ((view.actions?.rows ?? 0) > 0 || (view.actions?.cells?.length ?? 0) > 0);

  const tutorialText = (
    <div
      className={`grid grid-cols-1 md:grid-cols-2 gap-x-6 ${
        isShortScreen ? "gap-y-1" : "gap-y-3 md:gap-y-4"
      } text-left border-t border-ink/10 pt-3 sm:pt-4 text-[11px] md:text-[15px] lg:text-base`}
    >
      <div className="flex flex-col gap-1 md:col-span-2 pb-1 md:pb-2 text-center">
        <p className="leading-relaxed">
          <strong>Drag and drop</strong> cards between designated areas. Moves
          are validated based on rules and only allowed on your own turn.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <p className="leading-relaxed">
          The <strong className="text-red-600">MENU</strong> label provides
          additional options like changing card sets, themes, or exiting the
          game.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <p className="leading-relaxed">
          See the <strong className="text-red-600">RULES</strong> label in the
          header to view detailed game rules and card rankings at any time.
        </p>
      </div>
      {hasScoreboards && (
        <div className="flex flex-col gap-1">
          <p className="leading-relaxed">
            The <strong className="text-red-600">SCORES</strong> label shows
            current rankings or highlights the scoreboard on the tabletop.
          </p>
        </div>
      )}
      {hasActions && (
        <div className="flex flex-col gap-1">
          <p className="leading-relaxed">
            The <strong className="text-red-600">ACTIONS</strong> label appears
            when special moves beyond drawing and playing cards are available.
          </p>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <p className="leading-relaxed">
          The <strong className="text-red-600">TURN</strong> badge tracks the
          active player. Click it anytime to view the <strong>Game Log</strong>
          —a complete history of moves and the reasoning behind AI decisions.
        </p>
      </div>
    </div>
  );

  return (
    <>
      {showTutorial && (
        <>
          <TutorialHighlight
            isVisible={true}
            targetId="tutorial-rules-btn"
            label="Rules"
          />
          {hasScoreboards && (
            <TutorialHighlight
              isVisible={true}
              targetId="tutorial-scores-btn"
              label="Scores"
            />
          )}
          {hasActions && (
            <TutorialHighlight
              isVisible={true}
              targetId="tutorial-actions-btn"
              label="Actions"
            />
          )}
          <TutorialHighlight
            isVisible={true}
            targetId="tutorial-log-btn"
            label="Turn"
          />
          <TutorialHighlight
            isVisible={true}
            targetId="tutorial-menu-btn"
            label="Menu"
          />
        </>
      )}

      <FullScreenMessage
        title={
          isNextRound ? "Continue to the next round" : "All players have joined"
        }
        position="bottom"
        titleClassName={`${isShortScreen ? "text-xl mb-0.5" : "text-2xl mb-2"}`}
        blockInteractionsWhenMinimized={true}
        description={
          <div
            className={`flex flex-col ${
              isShortScreen ? "gap-1" : "gap-4 md:gap-8"
            }`}
          >
            {/* Subtitle - Centered and compact */}
            <span className="text-center w-full opacity-90 leading-tight block font-medium text-[12px] md:text-base">
              {mainDescription}
            </span>

            {/* Instructions - Grid on wider screens, stacked on small mobile. 
                Auto-hide detailed grid on VERY short screens to ensure the Start button is visible. */}
            <div
              className={`w-full overflow-hidden ${
                !showTutorial || isShortScreen ? "hidden" : "block"
              }`}
            >
              {tutorialText}
            </div>
          </div>
        }
        translucent
        panelClassName={`p-3 md:p-10 max-w-[95vw] md:max-w-5xl max-h-[92vh] overflow-y-auto scrollbar-hide`}
        canMinimize={true}
        action={
          !isSpectator || canSpectatorStart ? (
            <div className={isShortScreen ? "" : "mt-4 md:mt-6"}>
              <button
                type="button"
                data-testid="start-game"
                className={`button-base button-primary px-6 ${
                  isShortScreen
                    ? "py-1.5 text-[11px] mt-2"
                    : "py-3 text-sm md:text-base"
                }`}
                onClick={handleClick}
              >
                {isNextRound ? "Start next round" : "Start game"}
              </button>
            </div>
          ) : null
        }
      />
    </>
  );
}
