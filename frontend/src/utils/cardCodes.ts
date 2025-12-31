const rankCodeMap: Record<string, string> = {
  A: "A",
  K: "K",
  Q: "Q",
  J: "J",
  T: "T",
  "10": "T",
  9: "9",
  8: "8",
  7: "7",
  6: "6",
  5: "5",
  4: "4",
  3: "3",
  2: "2",
  JOKER: "JOKER",
};

const suitCodeMap: Record<string, string> = {
  spade: "S",
  spades: "S",
  s: "S",
  "♠": "S",
  heart: "H",
  hearts: "H",
  h: "H",
  "♥": "H",
  club: "C",
  clubs: "C",
  c: "C",
  "♣": "C",
  diamond: "D",
  diamonds: "D",
  d: "D",
  "♦": "D",
  red: "red",
  black: "black",
};

export const normalizeRank = (rank?: string | number | null): string | null => {
  if (rank === null || rank === undefined) return null;
  const key = String(rank).trim().toUpperCase();
  if (key.includes("JOKER")) return "JOKER";
  return rankCodeMap[key] ?? null;
};

export const normalizeSuit = (suit?: string | number | null): string | null => {
  if (!suit) return null;
  const key = String(suit).trim().toLowerCase();
  return suitCodeMap[key] ?? null;
};

export interface CardIdentity {
  rank?: string | number | null;
  suit?: string | null;
}

export const normalizeCardIdentity = (
  card: CardIdentity
): { rank: string | null; suit: string | null } => ({
  rank: normalizeRank(card.rank),
  suit: normalizeSuit(card.suit),
});
