/**
 * Deterministic PRNG and shuffling utilities.
 *
 * These are used by both the core engine and individual rule modules
 * to ensure that shuffling is consistent and reproducible across
 * different clients and AI seats.
 */

/**
 * Mulberry32 - A simple, fast, and seedable 32-bit PRNG.
 * @param seed A 32-bit integer seed.
 * @returns A function that generates a random number between 0 and 1.
 */
export function createRandom(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates shuffle algorithm.
 * @param array The array to shuffle.
 * @param random A function that returns a random number between 0 and 1.
 * @returns A new array containing the shuffled elements.
 */
export function fisherYates<T>(array: T[], random: () => number): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Converts a string seed into a 32-bit integer.
 */
export function stringToSeed(str: string): number {
  let hash = 0,
    i,
    chr;
  if (str.length === 0) return hash;
  for (i = 0; i < str.length; i++) {
    chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return Math.abs(hash);
}
