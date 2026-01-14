import { forwardRef, HTMLAttributes, CSSProperties, useEffect } from "react";
import { useAtom, useAtomValue } from "jotai";
import type { CardView, PileLayout } from "../../../shared/schemas";
import {
  DEFAULT_CARD_BACK,
  DEFAULT_CARD_SET,
  findCardSetById,
} from "../cardSets";
import {
  activeTransitionCardIdsAtom,
  cardSetAtom,
  freeDragEnabledAtom,
  gameViewAtom,
  moveTypeAtom,
  selectedCardAtom,
} from "../state";
import { normalizeRank, normalizeSuit } from "../utils/cardCodes";
import { isTestMode } from "../utils/testMode";

const frontCacheByGame = new Map<string, Map<number, string>>();

const getFrontCache = (gameId?: string | null) => {
  if (!gameId) return null;
  const existing = frontCacheByGame.get(gameId);
  if (existing) return existing;
  const next = new Map<number, string>();
  frontCacheByGame.set(gameId, next);
  return next;
};

const buildCardAssetPath = (
  card: CardView,
  cardSet: string,
  supportsJokers: boolean,
  cardSetPath?: string,
  options?: { forceFaceDown?: boolean }
) => {
  const assetBase = cardSetPath
    ? `/cards/${cardSetPath}/`
    : `/cards/${cardSet}/`;

  const faceDown = options?.forceFaceDown ?? card.faceDown;

  if (faceDown) {
    return `${assetBase}${DEFAULT_CARD_BACK}.svg`;
  }

  const rankCode = normalizeRank(card.rank);

  if (!rankCode) {
    return undefined;
  }

  if (rankCode === "JOKER") {
    if (!supportsJokers) {
      return undefined;
    }
    const suitCode = normalizeSuit(card.suit);
    const filename = suitCode === "black" ? "2J" : "1J";
    return `${assetBase}${filename}.svg`;
  }

  const suitCode = normalizeSuit(card.suit);
  if (!suitCode || suitCode === "red" || suitCode === "black") {
    return undefined;
  }

  return `${assetBase}${rankCode}${suitCode}.svg`;
};

const getCardAssetPaths = (
  card: CardView,
  selectedCardSet: string
): { front: string; back: string; frontCandidate?: string } => {
  const selectedSet = findCardSetById(selectedCardSet);
  const fallbackSet = findCardSetById(DEFAULT_CARD_SET);

  const primaryFront = buildCardAssetPath(
    card,
    selectedSet?.id ?? selectedCardSet,
    selectedSet?.supportsJokers ?? true,
    selectedSet?.path,
    { forceFaceDown: false }
  );

  const primaryBack = buildCardAssetPath(
    card,
    selectedSet?.id ?? selectedCardSet,
    selectedSet?.supportsJokers ?? true,
    selectedSet?.path,
    { forceFaceDown: true }
  );

  let frontCandidate = primaryFront;

  if (!frontCandidate && selectedSet?.id !== fallbackSet?.id && fallbackSet) {
    frontCandidate = buildCardAssetPath(
      card,
      fallbackSet.id,
      fallbackSet.supportsJokers,
      fallbackSet.path,
      { forceFaceDown: false }
    );
  }

  const backSet =
    selectedSet ?? fallbackSet ?? findCardSetById(DEFAULT_CARD_SET);
  const backSetPath = backSet?.path ?? backSet?.id ?? DEFAULT_CARD_SET;
  const back = primaryBack ?? `/cards/${backSetPath}/${DEFAULT_CARD_BACK}.svg`;

  return {
    front: frontCandidate ?? back,
    back,
    frontCandidate: frontCandidate ?? undefined,
  };
};

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  card: CardView;
  index?: number;
  pileLayout?: PileLayout;
  pileId?: string;
  isMoveTarget?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  (
    {
      card,
      className = "",
      index = 0,
      pileLayout = "complete",
      pileId,
      isMoveTarget,
      style,
      ...rest
    },
    ref
  ) => {
    const selectedCardSet = useAtomValue(cardSetAtom);
    const view = useAtomValue(gameViewAtom);
    const frontCache = getFrontCache(view?.gameId);
    const { front, back, frontCandidate } = getCardAssetPaths(
      card,
      selectedCardSet
    );
    const cachedFront = frontCache?.get(card.id);
    const frontAsset = frontCandidate ?? cachedFront ?? front;
    const [selectedCard, setSelectedCard] = useAtom(selectedCardAtom);
    const moveType = useAtomValue(moveTypeAtom);
    const freeDragEnabled = useAtomValue(freeDragEnabledAtom);
    const testMode = isTestMode();
    const isClickMoveActive = testMode || moveType === "click";

    const legalIntents = view?.legalIntents ?? [];
    const isMovable =
      freeDragEnabled ||
      legalIntents.some(
        (intent) =>
          intent.type === "move" &&
          intent.fromPileId === pileId &&
          intent.cardId === card.id
      );

    const isClickable = isClickMoveActive && (isMovable || isMoveTarget);

    void index;
    void pileLayout;
    const activeTransitionCardIds = useAtomValue(activeTransitionCardIdsAtom);
    const shouldAnimate = activeTransitionCardIds?.has(card.id) ?? false;

    const isSelected = isClickMoveActive && selectedCard?.cardId === card.id;

    // Pulse cards that are allowed to move when free move is off.
    // This provides a helpful hint even in Drag mode.
    // We suppress the attention effect if the card is already highlighted as a target.
    const shouldPulseMovable = !freeDragEnabled && isMovable && !isMoveTarget;
    const mergedStyle: CSSProperties & { viewTransitionName?: string } = {
      width: "var(--card-width)",
      height: "var(--card-height)",
      ...style,
      viewTransitionName: shouldAnimate ? `card-${card.id}` : "none",
      ...(isSelected
        ? {
            transform: `${style?.transform ?? ""} translateY(-12px)`,
            zIndex: 100,
            transition: "transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1)",
          }
        : {}),
    };

    const handleCardClick = (e: React.MouseEvent) => {
      if (!isClickable) return;
      if (!pileId) return;

      // If we are clicking a card in a pile that is a valid move target,
      // and we have a DIFFERENT card selected, we assume the user wants to complete the move.
      // We let the event bubble to the Pile handler which will execute the move.
      if (isMoveTarget && selectedCard && selectedCard.cardId !== card.id) {
        return;
      }

      e.stopPropagation();

      if (
        selectedCard &&
        selectedCard.cardId === card.id &&
        selectedCard.fromPileId === pileId
      ) {
        setSelectedCard(null);
        return;
      }

      setSelectedCard({ fromPileId: pileId, cardId: card.id });
    };

    const finalClassName = `
                  relative select-none card-scene
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
                  ${className}
                  ${isSelected ? "shadow-2xl" : ""}
                  ${isClickable ? "cursor-pointer" : isMovable ? "cursor-grab" : "cursor-default"}
                  ${!isClickMoveActive && isMovable ? "hover:ring-2 hover:ring-blue-300" : ""}
                `;

    const rotationStyle: CSSProperties | undefined =
      typeof card.rotationDeg === "number"
        ? {
            transform: `rotate(${card.rotationDeg}deg)`,
            transformOrigin: "center center",
          }
        : undefined;

    useEffect(() => {
      if (!card.faceDown && frontCandidate && frontCache) {
        frontCache.set(card.id, frontCandidate);
      }
    }, [card.faceDown, card.id, frontCandidate, frontCache]);

    return (
      <div
        ref={ref}
        className={finalClassName}
        style={mergedStyle}
        draggable={false}
        data-testid={card.faceDown ? `card:back:${card.id}` : `card:${card.id}`}
        data-selected={isSelected ? "true" : undefined}
        onClick={isClickable ? handleCardClick : undefined}
        tabIndex={isClickable ? 0 : -1}
        {...rest}
      >
        <div
          className={`card-flip ${card.faceDown ? "is-face-down" : "is-face-up"} ${shouldPulseMovable ? "animate-card-attention" : ""}`}
        >
          {" "}
          <div className="card-face card-face-front">
            <img
              src={frontAsset}
              alt={card.label ?? "Card"}
              className="w-full h-full object-contain drop-shadow-md"
              style={rotationStyle}
              draggable={false}
            />
          </div>
          <div className="card-face card-face-back">
            <img
              src={back}
              alt="Face-down card"
              className="w-full h-full object-contain drop-shadow-md"
              style={rotationStyle}
              draggable={false}
            />
          </div>
        </div>
      </div>
    );
  }
);

Card.displayName = "Card";
