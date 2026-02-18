import type { GameLayout, GameView, PileLayout } from "../../../shared/schemas";
import { choosePileSorter, sortCardsForDisplay } from "./pileSort";

type PileTransitionConfig = {
  layoutsByPileId: Record<string, string | undefined>;
  isHandByPileId: Record<string, boolean>;
  hasSortByPileId: Record<string, boolean>;
};

export function normalizePileLayout(val?: string): PileLayout | undefined {
  return val === "horizontal" ||
    val === "vertical" ||
    val === "complete" ||
    val === "spread"
    ? (val as PileLayout)
    : undefined;
}

export function buildPileTransitionConfig(
  layout: GameLayout | null
): PileTransitionConfig {
  const layoutsByPileId: Record<string, string | undefined> = {};
  const isHandByPileId: Record<string, boolean> = {};
  const hasSortByPileId: Record<string, boolean> = {};

  const pileStyles = layout?.pileStyles ?? {};
  for (const [pileId, style] of Object.entries(pileStyles)) {
    layoutsByPileId[pileId] = style.layout;
    isHandByPileId[pileId] = !!style.isHand;
    hasSortByPileId[pileId] = !!style.sort;
  }

  return { layoutsByPileId, isHandByPileId, hasSortByPileId };
}

export function shouldAnimatePileReflow(
  pileId: string,
  view: GameView,
  config: PileTransitionConfig
): boolean {
  const basePile = view.piles.find((pile) => pile.id === pileId);
  const baseLayout = normalizePileLayout(basePile?.layout);
  const overrideLayout = normalizePileLayout(config.layoutsByPileId[pileId]);
  const layout = baseLayout ?? overrideLayout ?? "complete";

  if (layout === "spread") {
    return true;
  }
  if (layout === "horizontal" || layout === "vertical") {
    return config.isHandByPileId[pileId] || config.hasSortByPileId[pileId];
  }
  return false;
}

export function didPileOrderChange(
  pileId: string,
  prevView: GameView,
  nextView: GameView
): boolean {
  const prevPile = prevView.piles.find((pile) => pile.id === pileId);
  const nextPile = nextView.piles.find((pile) => pile.id === pileId);
  if (!prevPile || !nextPile) {
    return false;
  }
  if (prevPile.cards.length !== nextPile.cards.length) {
    return true;
  }
  for (let i = 0; i < prevPile.cards.length; i += 1) {
    if (prevPile.cards[i]?.id !== nextPile.cards[i]?.id) {
      return true;
    }
  }
  return false;
}

export function sortViewPiles(
  view: GameView,
  layout: GameLayout | null,
  selections: Record<string, string>
): GameView {
  if (!layout || !layout.pileStyles) return view;

  const nextPiles = view.piles.map((pile) => {
    const style = layout.pileStyles?.[pile.id];
    if (!style || !style.sort) return pile;

    const sortConfig = style.sort;
    const optionIds = sortConfig.options?.map((o) => o.id) ?? [];
    const fallbackSortId =
      sortConfig.default && optionIds.includes(sortConfig.default)
        ? sortConfig.default
        : optionIds[0];

    const selectedSortId =
      selections[pile.id] && optionIds.includes(selections[pile.id])
        ? selections[pile.id]
        : fallbackSortId;

    const { sorter } = choosePileSorter(sortConfig, selectedSortId);
    const sortedCards = sortCardsForDisplay(
      pile.cards,
      sorter,
      normalizePileLayout(pile.layout) ??
        normalizePileLayout(style.layout) ??
        "complete"
    );

    return { ...pile, cards: sortedCards };
  });

  return { ...view, piles: nextPiles };
}

export type { PileTransitionConfig };
