/**
 * Standardized notation for card suits and ranks in user-facing messages.
 * This ensures consistency across all games (e.g. using ♠️ instead of "spades").
 */

export const SUIT_SYMBOLS: Record<string, string> = {
  clubs: "♣️",
  diamonds: "♦️",
  hearts: "♥️",
  spades: "♠️",
};

/**
 * Returns the standardized symbol for a suit (e.g. "♠️" for "spades").
 * If the suit is not found, returns the suit string as is (capitalized).
 */
export function getSuitSymbol(suit: string): string {
  return SUIT_SYMBOLS[suit.toLowerCase()] || suit;
}

/**
 * Formats a card name with standardized notation (e.g. "7♠️" or "K♥️").
 * @param rank The rank of the card (e.g. "7", "K", "10")
 * @param suit The suit of the card (e.g. "spades", "hearts")
 */
export function formatCard(rank: string, suit: string): string {
  return `${rank}${getSuitSymbol(suit)}`;
}
