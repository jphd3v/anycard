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
  gameViewAtom,
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
    const view = useAtomValue(gameViewAtom);
    const frontCache = getFrontCache(view?.gameId);
    const { front, back, frontCandidate } = getCardAssetPaths(
      card,
      selectedCardSet
    );
    const cachedFront = frontCache?.get(card.id);
    const frontAsset = frontCandidate ?? cachedFront ?? front;
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
      relative select-none card-scene
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
      ${className}
      ${
        testMode && isSelected
          ? "ring-4 ring-yellow-400 ring-inset shadow-lg"
          : ""
      }
      ${testMode ? "cursor-pointer hover:ring-2 hover:ring-blue-300" : ""}
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
        data-selected={testMode && isSelected ? "true" : undefined}
        onClick={testMode ? handleCardClick : undefined}
        tabIndex={0}
        {...rest}
      >
        <div
          className={`card-flip ${card.faceDown ? "is-face-down" : "is-face-up"}`}
        >
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
