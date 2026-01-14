// backend/src/ai/recap-manager.ts
// Manages seat-specific recap (replaces historyDigest + memory duplication)

/**
 * Maximum number of recap entries to keep per seat.
 * Recap includes both turn summaries and round summaries.
 */
export const MAX_RECAP_ENTRIES = 80;

/**
 * Maximum characters per recap entry.
 */
export const MAX_RECAP_ENTRY_CHARS = 150;

/**
 * In-memory storage of recap by seat.
 * Key format: "gameId:seatId"
 */
const recapBySeat = new Map<string, string[]>();

function buildKey(gameId: string, seatId: string): string {
  return `${gameId}:${seatId}`;
}

/**
 * Get the current recap for a seat.
 * Returns empty array if no recap exists.
 */
export function getRecap(gameId: string, seatId: string): string[] {
  return recapBySeat.get(buildKey(gameId, seatId)) ?? [];
}

/**
 * Append a new entry to the recap for a seat.
 * Automatically trims to MAX_RECAP_ENTRIES.
 *
 * @param gameId Game ID
 * @param seatId Seat ID
 * @param entry Entry to append (will be trimmed if too long)
 * @returns Updated recap array
 */
export function appendRecap(
  gameId: string,
  seatId: string,
  entry: string
): string[] {
  const key = buildKey(gameId, seatId);
  const currentRecap = recapBySeat.get(key) ?? [];

  const trimmedEntry = entry.trim();
  if (!trimmedEntry) {
    return currentRecap;
  }

  // Clip entry if too long
  const clipped =
    trimmedEntry.length > MAX_RECAP_ENTRY_CHARS
      ? `${trimmedEntry.slice(0, Math.max(MAX_RECAP_ENTRY_CHARS - 3, 0))}...`
      : trimmedEntry;

  const updated = [...currentRecap, clipped];

  // Keep only last MAX_RECAP_ENTRIES
  const bounded = updated.slice(-MAX_RECAP_ENTRIES);

  recapBySeat.set(key, bounded);
  return bounded;
}

/**
 * Replace the entire recap for a seat.
 * Useful for round summaries that collapse previous entries.
 *
 * @param gameId Game ID
 * @param seatId Seat ID
 * @param entries New recap entries
 * @returns Updated recap array
 */
export function setRecap(
  gameId: string,
  seatId: string,
  entries: string[]
): string[] {
  const key = buildKey(gameId, seatId);

  // Validate and clip each entry
  const validated = entries
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) =>
      e.length > MAX_RECAP_ENTRY_CHARS
        ? `${e.slice(0, Math.max(MAX_RECAP_ENTRY_CHARS - 3, 0))}...`
        : e
    );

  // Keep only last MAX_RECAP_ENTRIES
  const bounded = validated.slice(-MAX_RECAP_ENTRIES);

  recapBySeat.set(key, bounded);
  return bounded;
}

/**
 * Clear recap for a seat (useful when game ends or resets).
 */
export function clearRecap(gameId: string, seatId: string): void {
  recapBySeat.delete(buildKey(gameId, seatId));
}

/**
 * Clear all recap for a game (all seats).
 */
export function clearGameRecap(gameId: string): void {
  const prefix = `${gameId}:`;
  const keysToDelete: string[] = [];

  for (const key of recapBySeat.keys()) {
    if (key.startsWith(prefix)) {
      keysToDelete.push(key);
    }
  }

  for (const key of keysToDelete) {
    recapBySeat.delete(key);
  }
}

/**
 * Collapse previous recap into a single summary entry.
 * Useful for round-end summaries.
 *
 * @param gameId Game ID
 * @param seatId Seat ID
 * @param summary Summary string to replace previous entries
 * @returns Updated recap array with just the summary
 */
export function collapseRecap(
  gameId: string,
  seatId: string,
  summary: string
): string[] {
  return setRecap(gameId, seatId, [summary]);
}

/**
 * Append a round summary and optionally collapse previous entries.
 *
 * @param gameId Game ID
 * @param seatId Seat ID
 * @param roundSummary Summary of the round
 * @param collapsePrevious If true, replace all previous entries with this summary
 * @returns Updated recap array
 */
export function appendRoundSummary(
  gameId: string,
  seatId: string,
  roundSummary: string,
  collapsePrevious: boolean = false
): string[] {
  if (collapsePrevious) {
    return collapseRecap(gameId, seatId, roundSummary);
  }
  return appendRecap(gameId, seatId, roundSummary);
}
