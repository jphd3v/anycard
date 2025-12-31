import type {
  CardView,
  LayoutPileSortConfig,
  LayoutPileSortOption,
  PileLayout,
} from "../../../shared/schemas";
import {
  normalizeCardIdentity,
  normalizeRank,
  normalizeSuit,
} from "./cardCodes";

type DecoratedCard = {
  card: CardView;
  index: number;
  rank: string | null;
  suit: string | null;
  slotIndex?: number;
};

const MAX_ORDER = Number.MAX_SAFE_INTEGER;

const buildOrderMap = (
  values: string[] | undefined,
  normalizeFn: (val: string | number | null | undefined) => string | null
): Map<string, number> => {
  const map = new Map<string, number>();
  if (!values) return map;
  values.forEach((val, idx) => {
    const key = normalizeFn(val);
    if (key) {
      map.set(key, idx);
    }
  });
  return map;
};

const decorateCards = (cards: CardView[]): DecoratedCard[] =>
  cards.map((card, index) => {
    const { rank, suit } = normalizeCardIdentity(card);
    return { card, index, rank, suit };
  });

const shouldSkipSort = (
  sorter: LayoutPileSortOption | undefined,
  pileLayout: PileLayout | undefined,
  cards: CardView[]
): boolean => {
  if (!sorter) return true;
  if (
    sorter.applyToLayouts &&
    pileLayout &&
    !sorter.applyToLayouts.includes(pileLayout)
  ) {
    return true;
  }
  const includeFaceDown = sorter.includeFaceDown ?? false;
  if (!includeFaceDown && cards.some((c) => c.faceDown)) {
    return true;
  }
  return false;
};

const compareNumbers = (a: number, b: number): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

const compareBySuitThenRank = (
  a: DecoratedCard,
  b: DecoratedCard,
  suitOrder: Map<string, number>,
  rankOrder: Map<string, number>
): number => {
  const suitA = a.suit ? (suitOrder.get(a.suit) ?? MAX_ORDER) : MAX_ORDER;
  const suitB = b.suit ? (suitOrder.get(b.suit) ?? MAX_ORDER) : MAX_ORDER;
  const suitDiff = suitA - suitB;
  if (suitDiff !== 0) return suitDiff;

  const rankA = a.rank ? (rankOrder.get(a.rank) ?? MAX_ORDER) : MAX_ORDER;
  const rankB = b.rank ? (rankOrder.get(b.rank) ?? MAX_ORDER) : MAX_ORDER;
  const rankDiff = rankA - rankB;
  if (rankDiff !== 0) return rankDiff;

  return a.index - b.index;
};

const compareByRank = (
  a: DecoratedCard,
  b: DecoratedCard,
  rankOrder: Map<string, number>,
  suitOrder: Map<string, number>
): number => {
  const rankA = a.rank ? (rankOrder.get(a.rank) ?? MAX_ORDER) : MAX_ORDER;
  const rankB = b.rank ? (rankOrder.get(b.rank) ?? MAX_ORDER) : MAX_ORDER;
  const rankDiff = rankA - rankB;
  if (rankDiff !== 0) return rankDiff;

  const suitA = a.suit ? (suitOrder.get(a.suit) ?? MAX_ORDER) : MAX_ORDER;
  const suitB = b.suit ? (suitOrder.get(b.suit) ?? MAX_ORDER) : MAX_ORDER;
  const suitDiff = suitA - suitB;
  if (suitDiff !== 0) return suitDiff;

  return a.index - b.index;
};

const compareBySuit = (
  a: DecoratedCard,
  b: DecoratedCard,
  suitOrder: Map<string, number>,
  rankOrder: Map<string, number>
): number => {
  const suitA = a.suit ? (suitOrder.get(a.suit) ?? MAX_ORDER) : MAX_ORDER;
  const suitB = b.suit ? (suitOrder.get(b.suit) ?? MAX_ORDER) : MAX_ORDER;
  const suitDiff = suitA - suitB;
  if (suitDiff !== 0) return suitDiff;

  const rankA = a.rank ? (rankOrder.get(a.rank) ?? MAX_ORDER) : MAX_ORDER;
  const rankB = b.rank ? (rankOrder.get(b.rank) ?? MAX_ORDER) : MAX_ORDER;
  const rankDiff = rankA - rankB;
  if (rankDiff !== 0) return rankDiff;

  return a.index - b.index;
};

const decorateWithExplicitOrder = (
  cards: CardView[],
  sorter: Extract<LayoutPileSortOption, { type: "explicit" }>
): DecoratedCard[] => {
  const slots = sorter.order
    .map((item, idx) => ({
      idx,
      rank: normalizeRank(item.rank),
      suit: normalizeSuit(item.suit),
    }))
    .filter((slot) => slot.rank && slot.suit);

  const used = new Array(slots.length).fill(false);

  return cards.map((card, index) => {
    const { rank, suit } = normalizeCardIdentity(card);
    let slotIndex = MAX_ORDER;

    if (rank && suit) {
      for (let i = 0; i < slots.length; i += 1) {
        const slot = slots[i];
        if (!used[i] && slot.rank === rank && slot.suit === suit) {
          used[i] = true;
          slotIndex = slot.idx;
          break;
        }
      }
    }

    return { card, index, rank, suit, slotIndex };
  });
};

export const choosePileSorter = (
  config?: LayoutPileSortConfig,
  selectedId?: string
): { sorter?: LayoutPileSortOption; resolvedId?: string } => {
  if (!config?.options?.length) return {};
  const optionIds = config.options.map((o) => o.id);

  const preferred =
    selectedId && optionIds.includes(selectedId)
      ? selectedId
      : config.default && optionIds.includes(config.default)
        ? config.default
        : optionIds[0];

  const sorter = config.options.find((o) => o.id === preferred);
  if (!sorter) return {};
  return { sorter, resolvedId: sorter.id };
};

export const sortCardsForDisplay = (
  cards: CardView[],
  sorter: LayoutPileSortOption | undefined,
  pileLayout: PileLayout | undefined
): CardView[] => {
  if (shouldSkipSort(sorter, pileLayout, cards)) {
    return cards;
  }

  if (!sorter) return cards;

  if (sorter.type === "explicit") {
    const decorated = decorateWithExplicitOrder(cards, sorter);

    return decorated
      .slice()
      .sort((a, b) => {
        const slotDiff = compareNumbers(
          a.slotIndex ?? MAX_ORDER,
          b.slotIndex ?? MAX_ORDER
        );
        if (slotDiff !== 0) return slotDiff;
        return a.index - b.index;
      })
      .map((item) => item.card);
  }

  const rankOrder = buildOrderMap(sorter.rankOrder, normalizeRank);
  const suitOrder = buildOrderMap(sorter.suitOrder, normalizeSuit);
  const decorated = decorateCards(cards);

  if (sorter.type === "bySuitRank") {
    return decorated
      .slice()
      .sort((a, b) => compareBySuitThenRank(a, b, suitOrder, rankOrder))
      .map((item) => item.card);
  }

  if (sorter.type === "byRank") {
    return decorated
      .slice()
      .sort((a, b) => compareByRank(a, b, rankOrder, suitOrder))
      .map((item) => item.card);
  }

  if (sorter.type === "bySuit") {
    return decorated
      .slice()
      .sort((a, b) => compareBySuit(a, b, suitOrder, rankOrder))
      .map((item) => item.card);
  }

  return cards;
};
