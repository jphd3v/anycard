import { useDroppable, useDraggable } from "@dnd-kit/core";
import { CSSProperties } from "react";
import { useAtom, useAtomValue } from "jotai";
import {
  gameViewAtom,
  playerIdAtom,
  selectedCardAtom,
  freeDragEnabledAtom,
} from "../state";
import type {
  PileView,
  CardView,
  LayoutPileSortOption,
} from "../../../shared/schemas";
import { Card } from "./Card";
import { isTestMode } from "../utils/testMode";
import { sendMoveIntent } from "../socket";

interface Props {
  pile: PileView;
  className?: string;
  disabled?: boolean;
  displayName?: string;
  hideTitle?: boolean;
  showDetails?: boolean;
  sortOptions?: LayoutPileSortOption[];
  selectedSortId?: string;
  allowViewerToggle?: boolean;
  isProxyTarget?: boolean;
  onChangeSort?: (sortId: string) => void;
}

function DraggableCard({
  card,
  pileId,
  disabled,
}: {
  card: CardView;
  pileId: string;
  disabled: boolean;
}) {
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `pile-${pileId}-card-${card.id}`,
    disabled,
    data: { pileId, cardId: card.id, card },
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ opacity: isDragging ? 0 : 1 }}
      className={
        disabled ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing"
      }
    >
      <Card card={card} pileId={pileId} />
    </div>
  );
}

export function Pile({
  pile,
  className,
  disabled,
  displayName,
  hideTitle,
  showDetails,
  sortOptions,
  selectedSortId,
  allowViewerToggle = true,
  isProxyTarget = false,
  onChangeSort,
}: Props) {
  const { setNodeRef, isOver } = useDroppable({
    id: pile.id,
    disabled: disabled || isProxyTarget,
  });
  const [selectedCard, setSelectedCard] = useAtom(selectedCardAtom);
  const testMode = isTestMode();
  const view = useAtomValue(gameViewAtom);
  const myPlayerId = useAtomValue(playerIdAtom);
  const freeDragEnabled = useAtomValue(freeDragEnabledAtom);
  const legalIntents = view?.legalIntents ?? [];

  const currentPlayerId = view?.currentPlayer;
  const isOwnerCurrentTurn =
    currentPlayerId && pile.ownerId === currentPlayerId;
  const isOpponentTurn = isOwnerCurrentTurn && pile.ownerId !== myPlayerId;
  const isMyTurn = isOwnerCurrentTurn && pile.ownerId === myPlayerId;
  const isHandPile = pile.id.includes("hand");
  const ownerSeat = view?.seats?.find((s) => s.seatId === pile.ownerId);
  const isAi = ownerSeat?.aiRuntime !== "none";
  const ownerName = ownerSeat?.name || pile.ownerId;
  const isMine = pile.ownerId === myPlayerId;
  const shouldAnimate = isOpponentTurn && isHandPile;

  const activeGlowClass = shouldAnimate
    ? isAi
      ? "ring-2 ring-indigo-400/60 shadow-[0_0_15px_rgba(99,102,241,0.25)]"
      : "ring-2 ring-amber-400/40 shadow-[0_0_15px_rgba(251,191,36,0.2)]"
    : isMyTurn && isHandPile
      ? "ring-2 ring-emerald-300/60 shadow-[0_0_15px_rgba(16,185,129,0.22)]"
      : "";

  const labelText = displayName ?? pile.label ?? "";

  const count = pile.cards.length;
  const layout = pile.layout ?? "complete";

  const availableSortOptions = sortOptions ?? [];
  const currentSortId =
    availableSortOptions.find((opt) => opt.id === selectedSortId)?.id ??
    availableSortOptions[0]?.id ??
    "";
  const viewerCanBenefit = isMine || pile.cards.some((c) => !c.faceDown);
  const showSortControl =
    allowViewerToggle &&
    !!onChangeSort &&
    availableSortOptions.length > 1 &&
    viewerCanBenefit;

  // DYNAMIC CONTAINER SIZING using CSS Calc
  const style: CSSProperties = {
    // Minimum size is always 1 card
    minWidth: "var(--card-width)",
    minHeight: "var(--card-height)",
    position: "relative",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
  };

  // Adjust container size for fanned piles so they take up space in the grid
  if (layout === "horizontal" && count > 1) {
    // Width = 1 card + (N-1) * fan_offset
    style.minWidth = `calc(var(--card-width) + (${count - 1} * var(--fan-x)))`;
  }
  if (layout === "complete" && count > 1) {
    // Very slight expansion for complete piles due to offset (0.25px * (count-1))
    style.minWidth = `calc(var(--card-width) + (${count - 1} * 0.25px))`;
    style.minHeight = `calc(var(--card-height) + (${count - 1} * 0.05px))`;
  }
  if (layout === "vertical" && count > 1) {
    style.minHeight = `calc(var(--card-height) + (${
      count - 1
    } * var(--fan-y)))`;
  }
  if (layout === "spread") {
    style.display = "flex";
    style.flexWrap = "wrap";
    style.gap = "4px";
    style.width = "100%";
    style.height = "100%";
    style.alignContent = "center";
  }

  const isDropTarget =
    testMode &&
    !!selectedCard &&
    legalIntents.some(
      (intent) =>
        intent.type === "move" &&
        intent.fromPileId === selectedCard.fromPileId &&
        intent.cardId === selectedCard.cardId &&
        intent.toPileId === pile.id
    );

  const handlePileClick = () => {
    if (!testMode || !selectedCard || disabled || !isDropTarget) return;
    if (!view?.gameId || !myPlayerId) return;

    sendMoveIntent(
      view.gameId,
      myPlayerId,
      selectedCard.fromPileId,
      pile.id,
      selectedCard.cardId
    );
    setSelectedCard(null);
  };

  return (
    <div className="flex flex-col items-center justify-start group relative pb-5">
      {/* Label with owner hint and optional sort selector */}
      {!hideTitle && (
        <div
          className={`w-full flex items-center gap-2 h-5 mb-1 ${
            showSortControl ? "justify-between" : "justify-center"
          }`}
        >
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-ink font-bold leading-none transition-opacity duration-200 opacity-100">
            {!isHandPile && <span>{labelText}</span>}
            {isHandPile && ownerName && (
              <span
                className={`inline-flex items-center px-2 py-[2px] rounded-full border text-[9px] font-semibold tracking-tight leading-none ${
                  isMine
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : isAi
                      ? "bg-indigo-50 text-indigo-700 border-indigo-300"
                      : "bg-amber-50 text-amber-800 border-amber-300"
                }`}
              >
                {isMine
                  ? "Your hand"
                  : ownerSeat?.aiRuntime === "backend"
                    ? `${ownerName} (AI: server)`
                    : ownerSeat?.aiRuntime === "frontend" &&
                        ownerSeat?.isAiControlledByYou
                      ? `${ownerName} (AI: this browser)`
                      : ownerSeat?.aiRuntime === "frontend"
                        ? `${ownerName} (AI: other browser)`
                        : isAi
                          ? `${ownerName} (AI)`
                          : ownerName}
              </span>
            )}
          </div>

          {showSortControl && (
            <select
              className="text-[10px] px-2 py-1 rounded-md border border-ink-muted/30 bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-primary"
              value={currentSortId}
              disabled={disabled}
              onChange={(e) => onChangeSort?.(e.target.value)}
            >
              {availableSortOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label ?? opt.id}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <div
        ref={setNodeRef}
        style={style}
        data-testid={`pile:${pile.id}`}
        className={`
           transition-all duration-500 rounded-lg
           ${isOver ? "ring-4 ring-blue-400/50 bg-blue-400/10" : ""}
           ${isDropTarget ? "cursor-pointer ring-2 ring-yellow-300/70" : ""}
           ${className ?? ""}
           ${activeGlowClass}
         `}
        onClick={testMode ? handlePileClick : undefined}
        data-droptarget={isDropTarget ? "true" : undefined}
      >
        {/* Placeholder for empty pile */}
        {count === 0 && (
          <div
            className="border-2 border-dashed border-ink-muted/20 rounded-lg flex items-center justify-center"
            style={{
              width: "var(--card-width)",
              height: "var(--card-height)",
              boxSizing: "border-box",
            }}
          >
            <span className="text-[10px] text-ink-muted/30 font-black uppercase tracking-tighter">
              {hideTitle ? labelText : "EMPTY"}
            </span>
          </div>
        )}

        {pile.cards.map((card, index) => {
          const movable =
            freeDragEnabled ||
            legalIntents.some(
              (intent) =>
                intent.type === "move" &&
                intent.fromPileId === pile.id &&
                intent.cardId === card.id
            );
          const dragDisabled = !!disabled || !movable || testMode;
          const isTopCard = index === pile.cards.length - 1;

          const cardStyle: CSSProperties = {
            position: "absolute",
            top: 0,
            left: 0,
          };

          if (layout === "horizontal") {
            cardStyle.left = `calc(${index} * var(--fan-x))`;
          } else if (layout === "vertical") {
            cardStyle.top = `calc(${index} * var(--fan-y))`;
          } else if (layout === "complete") {
            // Apply a very slight realistic stack offset
            cardStyle.left = `calc(${index} * 0.25px)`;
            cardStyle.top = `calc(${index} * -0.05px)`; // slightly offset downwards for perspective
          } else if (layout === "spread") {
            cardStyle.position = "relative";
            cardStyle.top = "auto";
            cardStyle.left = "auto";
          }

          const animationStyle: CSSProperties = {};
          if (shouldAnimate) {
            animationStyle.animation = isAi
              ? "card-shiver 3s ease-in-out infinite"
              : "card-shiver 4s ease-in-out infinite";
            animationStyle.animationDelay = `${index * 0.1}s`;
          }

          return (
            <div
              key={card.id}
              style={{ ...cardStyle, ...animationStyle, zIndex: index }}
              data-testid={isTopCard ? `pile-top:${pile.id}` : undefined}
              data-topcard={isTopCard ? "true" : undefined}
            >
              <DraggableCard
                card={card}
                pileId={pile.id}
                disabled={dragDisabled}
              />
            </div>
          );
        })}
      </div>

      <div
        data-testid={`pile-count:${pile.id}`}
        className={`absolute bottom-0 text-[10px] font-mono text-ink-muted bg-surface-2 px-1.5 rounded transition-opacity duration-200 ${
          showDetails ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        {count} {count === 1 ? "card" : "cards"}
      </div>
    </div>
  );
}
