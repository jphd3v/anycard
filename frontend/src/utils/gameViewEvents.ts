import type {
  CardView,
  GameView,
  ViewEventPayload,
} from "../../../shared/schemas";
import type { PendingDragMove } from "../state";

type ApplyViewEventOptions = {
  animateOnlyCards?: boolean;
};

export function applyViewEventToView(
  prev: GameView,
  event: ViewEventPayload,
  finalView: GameView,
  options?: ApplyViewEventOptions
): GameView {
  const animateOnlyCards = options?.animateOnlyCards ?? false;

  // Start with previous state but pull in metadata from the final authoritative view
  // because metadata often contains derived state (like phase) that doesn't have
  // explicit events but should be consistent with the move.
  const next = {
    ...prev,
    metadata: finalView.metadata,
  };

  switch (event.type) {
    case "move-cards": {
      const { fromPileId, toPileId, cardIds } = event;

      const idSet = new Set(cardIds);
      const eventCardById = new Map(
        event.cardViews?.map((card) => [card.id, card]) ?? []
      );

      // 1. Build a lookup of the final card views from the authoritative view.
      //    This is where orientation (faceDown) is correct for the target pile.
      const finalCardById = new Map<number, CardView>();
      for (const pile of finalView.piles) {
        for (const card of pile.cards) {
          if (idSet.has(card.id)) {
            finalCardById.set(card.id, card);
          }
        }
      }

      // 2. Capture cards from the source pile in the previous view,
      //    preserving source order. If the move was optimistic, fall back to
      //    the destination pile or final view so we don't drop the card.
      const fromPile = prev.piles.find((p) => p.id === fromPileId);
      const toPile = prev.piles.find((p) => p.id === toPileId);
      let movedCards =
        fromPile?.cards.filter((card) => idSet.has(card.id)) ?? [];
      if (movedCards.length === 0) {
        movedCards = toPile?.cards.filter((card) => idSet.has(card.id)) ?? [];
      }
      if (movedCards.length === 0) {
        movedCards = cardIds
          .map(
            (cardId) => eventCardById.get(cardId) ?? finalCardById.get(cardId)
          )
          .filter((card): card is CardView => !!card);
      }
      if (movedCards.length > 1) {
        const seenIds = new Set<number>();
        movedCards = movedCards.filter((card) => {
          if (seenIds.has(card.id)) return false;
          seenIds.add(card.id);
          return true;
        });
      }

      // 3. Replace movedCards with their final representation when available.
      if (finalCardById.size > 0 || eventCardById.size > 0) {
        movedCards = movedCards.map((card) => {
          const eventCard = eventCardById.get(card.id);
          const finalCard = finalCardById.get(card.id);
          const targetCard = eventCard ?? finalCard;
          if (!targetCard) {
            return card;
          }
          if (card.faceDown && !targetCard.faceDown) {
            // Keep the card back while it moves; flip after settling.
            return { ...targetCard, faceDown: true };
          }
          if (!card.faceDown && targetCard.faceDown) {
            // Keep the face-up front during travel; flip after movement settles.
            return {
              id: targetCard.id,
              label: card.label ?? targetCard.label,
              rank: card.rank ?? targetCard.rank,
              suit: card.suit ?? targetCard.suit,
              faceDown: false,
              rotationDeg: targetCard.rotationDeg ?? card.rotationDeg,
            };
          }
          return targetCard;
        });
      }

      const piles = prev.piles.map((pile) => {
        if (pile.id === toPileId) {
          // Append moved cards to destination using their final orientation
          const nextCards = [
            ...pile.cards.filter((card) => !idSet.has(card.id)),
            ...movedCards,
          ];
          const seenIds = new Set<number>();
          return {
            ...pile,
            cards: nextCards.filter((card) => {
              if (seenIds.has(card.id)) return false;
              seenIds.add(card.id);
              return true;
            }),
          };
        }

        const filteredCards = pile.cards.filter((card) => !idSet.has(card.id));
        if (filteredCards.length !== pile.cards.length) {
          return { ...pile, cards: filteredCards };
        }
        return pile;
      });

      return { ...next, piles };
    }

    case "set-current-player":
      if (animateOnlyCards) {
        return { ...next, currentPlayer: finalView.currentPlayer ?? null };
      }
      return { ...next, currentPlayer: event.player ?? null };

    case "set-winner":
      if (animateOnlyCards) {
        return { ...next, winner: finalView.winner ?? null };
      }
      return { ...next, winner: event.winner ?? null };

    case "set-scoreboards":
      if (animateOnlyCards) {
        return next;
      }
      return { ...next, scoreboards: event.scoreboards };

    case "set-actions":
      if (animateOnlyCards) {
        return next;
      }
      return { ...next, actions: event.actions };

    case "set-rules-state":
      if (animateOnlyCards) {
        return next;
      }
      return { ...next, rulesState: event.rulesState };

    case "set-pile-visibility": {
      const pileId = event.pileId;
      const finalPile = finalView.piles.find((p) => p.id === pileId);
      if (!finalPile) {
        return next;
      }
      const piles = prev.piles.map((pile) =>
        pile.id === pileId ? { ...pile, cards: finalPile.cards } : pile
      );
      return { ...next, piles };
    }

    case "announce":
      return next;

    case "fatal-error":
      // Fatal errors are handled by setting the error state atom,
      // but we return the state unchanged since the error is global
      return next;

    default:
      // Unknown event types are ignored for now
      return next;
  }
}

export function applyOptimisticDragMove(
  prev: GameView,
  move: PendingDragMove
): GameView {
  const fromPile = prev.piles.find((pile) => pile.id === move.fromPileId);
  const toPile = prev.piles.find((pile) => pile.id === move.toPileId);
  if (!fromPile || !toPile) {
    return prev;
  }
  const cardIndex = fromPile.cards.findIndex((card) => card.id === move.cardId);
  if (cardIndex === -1) {
    return prev;
  }
  const movingCard = fromPile.cards[cardIndex];

  const piles = prev.piles.map((pile) => {
    if (pile.id === move.fromPileId) {
      return {
        ...pile,
        cards: pile.cards.filter((card) => card.id !== move.cardId),
      };
    }
    if (pile.id === move.toPileId) {
      return {
        ...pile,
        cards: [...pile.cards, movingCard],
      };
    }
    return pile;
  });

  return { ...prev, piles };
}

export function applyMoveRevealToView(
  prev: GameView,
  event: ViewEventPayload,
  finalView?: GameView
): GameView {
  if (event.type !== "move-cards") {
    return prev;
  }

  const revealById = new Map<number, CardView>();
  for (const card of event.cardViews ?? []) {
    revealById.set(card.id, card);
  }
  if (finalView) {
    const finalCards = getCardViewsForIds(finalView, event.cardIds);
    for (const card of finalCards) {
      if (!revealById.has(card.id)) {
        revealById.set(card.id, card);
      }
    }
  }

  if (revealById.size === 0) {
    return prev;
  }
  let changed = false;

  const piles = prev.piles.map((pile) => {
    let nextCards = pile.cards;
    for (let idx = 0; idx < pile.cards.length; idx += 1) {
      const card = pile.cards[idx];
      const reveal = revealById.get(card.id);
      if (!reveal) continue;
      if (
        card.faceDown === reveal.faceDown &&
        card.label === reveal.label &&
        card.rank === reveal.rank &&
        card.suit === reveal.suit &&
        card.rotationDeg === reveal.rotationDeg
      ) {
        continue;
      }
      if (nextCards === pile.cards) {
        nextCards = [...pile.cards];
      }
      nextCards[idx] = reveal;
      changed = true;
    }
    if (nextCards === pile.cards) {
      return pile;
    }
    return { ...pile, cards: nextCards };
  });

  if (!changed) {
    return prev;
  }

  return { ...prev, piles };
}

export function getCardViewsForIds(
  view: GameView,
  cardIds: number[]
): CardView[] {
  if (cardIds.length === 0) {
    return [];
  }

  const idSet = new Set(cardIds);
  const cardById = new Map<number, CardView>();

  for (const pile of view.piles) {
    for (const card of pile.cards) {
      if (idSet.has(card.id)) {
        cardById.set(card.id, card);
      }
    }
  }

  const ordered: CardView[] = [];
  for (const cardId of cardIds) {
    const card = cardById.get(cardId);
    if (card) {
      ordered.push(card);
    }
  }

  return ordered;
}

export function collectDuplicateCardIds(
  view: GameView,
  extraCards: CardView[] = [],
  visiblePileIds?: Set<string>
): Set<number> {
  const seen = new Set<number>();
  const duplicates = new Set<number>();

  for (const pile of view.piles) {
    if (visiblePileIds && !visiblePileIds.has(pile.id)) {
      continue;
    }
    for (const card of pile.cards) {
      if (seen.has(card.id)) {
        duplicates.add(card.id);
      } else {
        seen.add(card.id);
      }
    }
  }

  for (const card of extraCards) {
    if (seen.has(card.id)) {
      duplicates.add(card.id);
    } else {
      seen.add(card.id);
    }
  }

  return duplicates;
}
