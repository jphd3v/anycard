import { forwardRef, HTMLAttributes, CSSProperties } from "react";
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
  selectedCardAtom,
} from "../state";
import { normalizeRank, normalizeSuit } from "../utils/cardCodes";
import { isTestMode } from "../utils/testMode";

const buildCardAssetPath = (
  card: CardView,
  cardSet: string,
  supportsJokers: boolean,
  cardSetPath?: string
) => {
  const assetBase = cardSetPath
    ? `/cards/${cardSetPath}/`
    : `/cards/${cardSet}/`;

  if (card.faceDown) {
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

const getCardAssetPath = (card: CardView, selectedCardSet: string): string => {
  const selectedSet = findCardSetById(selectedCardSet);
  const fallbackSet = findCardSetById(DEFAULT_CARD_SET);

  const primary = buildCardAssetPath(
    card,
    selectedSet?.id ?? selectedCardSet,
    selectedSet?.supportsJokers ?? true,
    selectedSet?.path
  );

  if (primary) {
    return primary;
  }

  if (selectedSet?.id !== fallbackSet?.id && fallbackSet) {
    const fallback = buildCardAssetPath(
      card,
      fallbackSet.id,
      fallbackSet.supportsJokers,
      fallbackSet.path
    );
    if (fallback) {
      return fallback;
    }
  }

  const backSet =
    selectedSet ?? fallbackSet ?? findCardSetById(DEFAULT_CARD_SET);
  const backSetPath = backSet?.path ?? backSet?.id ?? DEFAULT_CARD_SET;
  return `/cards/${backSetPath}/${DEFAULT_CARD_BACK}.svg`;
};

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  card: CardView;
  index?: number;
  pileLayout?: PileLayout;
  pileId?: string;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  (
    {
      card,
      className = "",
      index = 0,
      pileLayout = "complete",
      pileId,
      style,
      ...rest
    },
    ref
  ) => {
    const selectedCardSet = useAtomValue(cardSetAtom);
    const assetPath = getCardAssetPath(card, selectedCardSet);
    const [selectedCard, setSelectedCard] = useAtom(selectedCardAtom);
    const testMode = isTestMode();

    void index;
    void pileLayout;
    const activeTransitionCardIds = useAtomValue(activeTransitionCardIdsAtom);
    const shouldAnimate = activeTransitionCardIds?.has(card.id) ?? false;

    const mergedStyle: CSSProperties & { viewTransitionName?: string } = {
      width: "var(--card-width)",
      height: "var(--card-height)",
      ...style,
      viewTransitionName: shouldAnimate ? `card-${card.id}` : "none",
    };

    const handleCardClick = () => {
      if (!testMode) return;
      if (!pileId) return;

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

    const isSelected = selectedCard?.cardId === card.id;
    const finalClassName = `
      relative select-none
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
      ${className}
      ${
        testMode && isSelected
          ? "ring-4 ring-yellow-400 ring-inset shadow-lg"
          : ""
      }
      ${testMode ? "cursor-pointer hover:ring-2 hover:ring-blue-300" : ""}
    `;

    return (
      <div
        ref={ref}
        className={finalClassName}
        style={mergedStyle}
        draggable={false}
        data-testid={card.faceDown ? `card:back:${card.id}` : `card:${card.id}`}
        data-selected={testMode && isSelected ? "true" : undefined}
        onClick={testMode ? handleCardClick : undefined}
        tabIndex={0}
        {...rest}
      >
        <img
          src={assetPath}
          alt={card.faceDown ? "Face-down card" : (card.label ?? "Card")}
          className="w-full h-full object-contain drop-shadow-md"
          style={{
            transform:
              typeof card.rotationDeg === "number"
                ? `rotate(${card.rotationDeg}deg)`
                : undefined,
            transformOrigin: "center center",
          }}
          draggable={false}
        />
      </div>
    );
  }
);

Card.displayName = "Card";
