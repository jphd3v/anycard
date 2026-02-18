import { useDroppable, useDraggable, useDndContext } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CSSProperties, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import {
  gameViewAtom,
  playerIdAtom,
  selectedCardAtom,
  freeDragEnabledAtom,
  moveTypeAtom,
} from "../state";
import type {
  PileView,
  CardView,
  LayoutPileSortOption,
} from "../../../shared/schemas";
import { Card } from "./Card";
import { isTestMode } from "../utils/testMode";
import { sendMoveIntent, sendClientIntent } from "../socket";
import { isTouchOnlyDevice } from "../utils/touchDetection";

type PileDisplayView = PileView & { isHand?: boolean };

interface Props {
  pile: PileDisplayView;
  className?: string;
  disabled?: boolean;
  displayName?: string;
  hideTitle?: boolean;
  showDetails?: boolean;
  sortOptions?: LayoutPileSortOption[];
  selectedSortId?: string;
  allowViewerToggle?: boolean;
  isProxyTarget?: boolean;
  allowReorder?: boolean;
  compact?: boolean;
  onToggleCompact?: () => void;
  onChangeSort?: (sortId: string) => void;
}

function DraggableCard({
  card,
  pileId,
  disabled,
  isMoveTarget,
}: {
  card: CardView;
  pileId: string;
  disabled: boolean;
  isMoveTarget?: boolean;
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
      <Card card={card} pileId={pileId} isMoveTarget={isMoveTarget} />
    </div>
  );
}

function SortableCard({
  card,
  pileId,
  disabled,
  isMoveTarget,
}: {
  card: CardView;
  pileId: string;
  disabled: boolean;
  isMoveTarget?: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `sortable-${pileId}-card-${card.id}`,
    disabled,
    data: { pileId, cardId: card.id, card },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={
        disabled ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing"
      }
    >
      <Card card={card} pileId={pileId} isMoveTarget={isMoveTarget} />
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
  allowReorder = false,
  compact = false,
  onToggleCompact,
  onChangeSort,
}: Props) {
  const { setNodeRef, isOver } = useDroppable({
    id: pile.id,
    disabled: disabled || isProxyTarget,
  });
  const [selectedCard, setSelectedCard] = useAtom(selectedCardAtom);
  const moveType = useAtomValue(moveTypeAtom);
  const testMode = isTestMode();
  const isClickMoveActive = testMode || moveType === "click";
  const view = useAtomValue(gameViewAtom);
  const myPlayerId = useAtomValue(playerIdAtom);
  const freeDragEnabled = useAtomValue(freeDragEnabledAtom);
  const isTouchOnly = isTouchOnlyDevice();
  const { active } = useDndContext();
  const legalIntents = view?.legalIntents ?? [];
  const [isHovered, setIsHovered] = useState(false);

  const currentPlayerId = view?.currentPlayer;
  const localSeatId = myPlayerId;
  const isOwnerCurrentTurn =
    currentPlayerId && pile.ownerId === currentPlayerId;
  const isOpponentTurn = isOwnerCurrentTurn && pile.ownerId !== localSeatId;
  const isHandPile = pile.isHand ?? pile.id.includes("hand");
  const ownerSeat = view?.seats?.find((s) => s.seatId === pile.ownerId);
  const isAi = ownerSeat?.aiRuntime !== "none";
  const ownerName = ownerSeat?.name || pile.ownerId;
  const isMine = pile.ownerId === localSeatId;
  const shouldAnimate = isOpponentTurn && isHandPile;
  const showCompactSummary = compact && isHandPile;
  const showCompactToggle =
    !showCompactSummary && isHandPile && !!onToggleCompact;

  const activeGlowClass = shouldAnimate
    ? isAi
      ? "ring-2 ring-indigo-400/60 shadow-[0_0_15px_rgba(99,102,241,0.25)]"
      : "ring-2 ring-amber-400/40 shadow-[0_0_15px_rgba(251,191,36,0.2)]"
    : "";

  const labelText = displayName ?? pile.label ?? "";

  const count = pile.cards.length;
  const layout = pile.layout ?? "complete";
  const isVerticalHandLayout = isHandPile && layout === "vertical";
  const compactNameSource = labelText || ownerName || pile.ownerId || "";
  const compactOwnerLabel = (() => {
    const seatId = typeof pile.ownerId === "string" ? pile.ownerId.trim() : "";
    if (isVerticalHandLayout && /^P\d+$/i.test(seatId)) {
      return seatId.toUpperCase();
    }

    const trimmed = compactNameSource.trim();
    if (!trimmed) return "?";
    const firstToken = trimmed.split(/\s+/)[0] ?? trimmed;
    if (isVerticalHandLayout) {
      const compactToken = firstToken.replace(/[^A-Za-z0-9]/g, "");
      if (compactToken.length > 0 && compactToken.length <= 3) {
        return compactToken.toUpperCase();
      }
      return firstToken.charAt(0).toUpperCase();
    }
    return firstToken.toUpperCase();
  })();
  const ownerLabelText =
    isTouchOnly && isVerticalHandLayout ? compactOwnerLabel : ownerName;

  const availableSortOptions = sortOptions ?? [];
  const currentSortId =
    availableSortOptions.find((opt) => opt.id === selectedSortId)?.id ??
    availableSortOptions[0]?.id ??
    "";
  const currentSortLabel =
    availableSortOptions.find((opt) => opt.id === currentSortId)?.label ??
    currentSortId;
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
    isolation: "isolate",
  };

  if (showCompactSummary) {
    style.minWidth = "0";
    style.minHeight = "0";
    style.alignItems = "center";
  }

  if (!showCompactSummary) {
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
  }

  const dragData = active?.data.current as
    | { pileId?: string; cardId?: number }
    | undefined;
  const dragCardId =
    typeof dragData?.cardId === "number" ? dragData.cardId : null;
  const dragFromPileId =
    typeof dragData?.pileId === "string" ? dragData.pileId : null;
  const activeCardId = isClickMoveActive ? selectedCard?.cardId : dragCardId;
  const activeFromPileId = isClickMoveActive
    ? selectedCard?.fromPileId
    : dragFromPileId;
  const hasActiveSelection =
    typeof activeCardId === "number" && !!activeFromPileId;

  const isOverActive =
    isOver && (!dragFromPileId || dragFromPileId !== pile.id);
  const isDropTarget =
    !freeDragEnabled &&
    hasActiveSelection &&
    legalIntents.some(
      (intent) =>
        intent.type === "move" &&
        intent.fromPileId === activeFromPileId &&
        intent.toPileId === pile.id &&
        (intent.cardId === activeCardId ||
          intent.cardIds?.includes(activeCardId) === true)
    );

  const isFreeMoveTarget =
    !isProxyTarget &&
    freeDragEnabled &&
    isClickMoveActive &&
    !!selectedCard &&
    selectedCard.fromPileId !== pile.id &&
    (isHovered || isTouchOnly);

  const handlePileClick = (e: React.MouseEvent) => {
    if (!isClickMoveActive || !selectedCard || disabled) return;
    const canFreeMoveClickTarget =
      freeDragEnabled && selectedCard.fromPileId !== pile.id;
    if (!isDropTarget && !canFreeMoveClickTarget) return;
    if (!view?.gameId || !myPlayerId) return;

    e.stopPropagation();

    const matchingIntent = legalIntents.find(
      (intent) =>
        intent.type === "move" &&
        intent.fromPileId === selectedCard.fromPileId &&
        intent.toPileId === pile.id &&
        (intent.cardId === selectedCard.cardId ||
          intent.cardIds?.includes(selectedCard.cardId))
    );

    if (matchingIntent) {
      sendClientIntent(matchingIntent);
    } else {
      sendMoveIntent(
        view.gameId,
        myPlayerId,
        selectedCard.fromPileId,
        pile.id,
        selectedCard.cardId
      );
    }
    setSelectedCard(null);
  };

  return (
    <div
      className={`flex flex-col items-center justify-start group relative ${
        showCompactSummary ? "pb-0" : "pb-5"
      }`}
    >
      {/* Label with owner hint and optional sort selector */}
      {!hideTitle && !showCompactSummary && (
        <div className="w-full flex flex-wrap items-center justify-center gap-2 min-h-5 mb-1">
          <div className="flex items-center justify-center gap-2 text-[10px] uppercase tracking-widest text-ink font-bold leading-none transition-opacity duration-200 opacity-100">
            {!isHandPile && <span>{labelText}</span>}
            {isHandPile && ownerName && (
              <span className="inline-flex max-w-full flex-wrap items-center justify-center gap-1">
                <span className="text-[10px] font-bold whitespace-nowrap">
                  {ownerLabelText}
                </span>
                {(isMine || isAi || showCompactToggle) && (
                  <span className="inline-flex max-w-full flex-wrap items-center justify-center gap-1">
                    {isMine && (
                      <span className="px-1.5 py-[1px] rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200 text-[8px] font-semibold">
                        you
                      </span>
                    )}
                    {isAi && (
                      <span className="px-1.5 py-[1px] rounded-full bg-indigo-50 text-indigo-600 border border-indigo-200 text-[8px] font-semibold">
                        AI
                      </span>
                    )}
                    {showCompactToggle && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleCompact?.();
                        }}
                        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-surface-3 bg-surface-2 text-ink-muted transition-colors hover:text-ink cursor-pointer"
                        title="Minimize"
                        aria-label={`Minimize ${ownerName} hand`}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          fill="none"
                          viewBox="0 0 24 24"
                          strokeWidth={2}
                          stroke="currentColor"
                          className="h-3 w-3"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                          />
                        </svg>
                      </button>
                    )}
                  </span>
                )}
              </span>
            )}
          </div>

          {showSortControl && (
            <div
              className={`min-w-0 ${
                isTouchOnly && isVerticalHandLayout
                  ? "w-[4.5rem]"
                  : "w-[6.25rem]"
              }`}
            >
              <select
                className="w-full min-w-0 text-[9px] px-1.5 py-0.5 rounded-md border border-ink-muted/30 bg-surface text-ink leading-tight focus:outline-none focus:ring-1 focus:ring-primary overflow-hidden text-ellipsis whitespace-nowrap"
                value={currentSortId}
                title={currentSortLabel}
                disabled={disabled}
                onChange={(e) => onChangeSort?.(e.target.value)}
              >
                {availableSortOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label ?? opt.id}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      <div
        ref={setNodeRef}
        style={style}
        data-testid={`pile:${pile.id}`}
        className={`
           transition-all duration-500 rounded-lg
           ${(isOverActive && freeDragEnabled) || isFreeMoveTarget ? "ring-4 ring-target/50 bg-target/10" : ""}
           ${isDropTarget && !isProxyTarget ? "cursor-pointer" : ""}
           ${className ?? ""}
           ${activeGlowClass}
         `}
        onClick={
          showCompactSummary
            ? undefined
            : isClickMoveActive
              ? handlePileClick
              : undefined
        }
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        data-droptarget={isDropTarget ? "true" : undefined}
      >
        {isDropTarget && !isProxyTarget && (
          <div className="absolute inset-0 rounded-lg ring-4 ring-target/50 bg-target/10 animate-pulse-slow pointer-events-none z-50" />
        )}
        {showCompactSummary ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleCompact?.();
            }}
            className={`inline-flex border border-surface-3 bg-surface-2 text-ink cursor-pointer ${
              isVerticalHandLayout
                ? "flex-col items-center justify-center rounded-lg px-1.5 py-2 min-w-8 min-h-16 gap-1"
                : "items-center gap-2 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide"
            }`}
            aria-label={`Expand ${ownerName} hand`}
          >
            {isVerticalHandLayout ? (
              <>
                <span className="text-[9px] font-bold uppercase tracking-wider leading-none">
                  {compactOwnerLabel}
                </span>
                <span className="font-mono text-[11px] text-ink-muted leading-none">
                  {count}
                </span>
              </>
            ) : (
              <>
                <span>{compactOwnerLabel}</span>
                <span className="font-mono text-ink-muted">{count}</span>
                <span className="text-ink-muted">cards</span>
              </>
            )}
          </button>
        ) : (
          <>
            {/* Placeholder for empty pile */}
            {count === 0 && (
              <div
                className="pile-empty-placeholder border-2 border-dashed border-ink-muted/20 rounded-lg flex items-center justify-center"
                data-keep-label={hideTitle ? "true" : undefined}
                style={{
                  width: "var(--card-width)",
                  height: "var(--card-height)",
                  boxSizing: "border-box",
                }}
              >
                <span className="pile-empty-label text-[10px] text-ink-muted/30 font-black uppercase tracking-tighter">
                  {hideTitle ? labelText : "EMPTY"}
                </span>
              </div>
            )}

            {(() => {
              const isSortableEnabled =
                allowReorder && !isClickMoveActive && layout === "horizontal";
              const sortableIds = pile.cards.map(
                (card) => `sortable-${pile.id}-card-${card.id}`
              );

              const cardElements = pile.cards.map((card, index) => {
                const movable =
                  freeDragEnabled ||
                  legalIntents.some(
                    (intent) =>
                      intent.type === "move" &&
                      intent.fromPileId === pile.id &&
                      (intent.cardId === card.id ||
                        intent.cardIds?.includes(card.id))
                  );
                const dragDisabled =
                  !!disabled || !movable || isClickMoveActive;
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

                const CardComponent = isSortableEnabled
                  ? SortableCard
                  : DraggableCard;

                const isCardSelected =
                  isClickMoveActive &&
                  selectedCard?.cardId === card.id &&
                  selectedCard?.fromPileId === pile.id;
                const canReorderInClickMode =
                  allowReorder && isCardSelected && pile.cards.length > 1;
                const canMoveLeft = canReorderInClickMode && index > 0;
                const canMoveRight =
                  canReorderInClickMode && index < pile.cards.length - 1;

                return (
                  <div
                    key={card.id}
                    style={{ ...cardStyle, ...animationStyle, zIndex: index }}
                    data-testid={isTopCard ? `pile-top:${pile.id}` : undefined}
                    data-topcard={isTopCard ? "true" : undefined}
                  >
                    <CardComponent
                      card={card}
                      pileId={pile.id}
                      disabled={dragDisabled}
                      isMoveTarget={isDropTarget}
                    />
                    {canReorderInClickMode && (
                      <div
                        className={`absolute z-[200] pointer-events-auto ${
                          layout === "vertical"
                            ? "-left-8 top-1/2 -translate-y-1/2 flex flex-col gap-1"
                            : "-bottom-8 left-1/2 -translate-x-1/2 flex gap-1"
                        }`}
                      >
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (canMoveLeft && view?.gameId && myPlayerId) {
                              sendMoveIntent(
                                view.gameId,
                                myPlayerId,
                                pile.id,
                                pile.id,
                                card.id,
                                index - 1
                              );
                              setSelectedCard(null);
                            }
                          }}
                          disabled={!canMoveLeft}
                          className="px-2 py-1 rounded bg-action-surface text-action-ink text-xs font-bold shadow-lg hover:bg-action-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                          title={
                            layout === "vertical" ? "Move up" : "Move left"
                          }
                        >
                          {layout === "vertical" ? "↑" : "←"}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (canMoveRight && view?.gameId && myPlayerId) {
                              sendMoveIntent(
                                view.gameId,
                                myPlayerId,
                                pile.id,
                                pile.id,
                                card.id,
                                index + 1
                              );
                              setSelectedCard(null);
                            }
                          }}
                          disabled={!canMoveRight}
                          className="px-2 py-1 rounded bg-action-surface text-action-ink text-xs font-bold shadow-lg hover:bg-action-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                          title={
                            layout === "vertical" ? "Move down" : "Move right"
                          }
                        >
                          {layout === "vertical" ? "↓" : "→"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              });

              if (isSortableEnabled) {
                return (
                  <SortableContext
                    items={sortableIds}
                    strategy={horizontalListSortingStrategy}
                  >
                    {cardElements}
                  </SortableContext>
                );
              }

              return cardElements;
            })()}
          </>
        )}
      </div>

      {!showCompactSummary &&
        !(
          isClickMoveActive &&
          selectedCard?.fromPileId === pile.id &&
          pile.cards.length > 1
        ) && (
          <div
            data-testid={`pile-count:${pile.id}`}
            className={`absolute bottom-0 text-[10px] font-mono text-ink-muted bg-surface-2 px-1.5 rounded transition-opacity duration-200 whitespace-nowrap ${
              showDetails ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
          >
            {count} {count === 1 ? "card" : "cards"}
          </div>
        )}
    </div>
  );
}
