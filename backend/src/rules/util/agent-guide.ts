// backend/src/rules/util/agent-guide.ts

/**
 * Standard utility for managing the agentGuide property in rules state.
 * This helps maintain a clean and relevant history for LLM-based agents.
 */

export const HISTORY_DIGEST_MAX_ENTRIES = 20; // Increased slightly since it now contains round summaries too
export const HISTORY_DIGEST_MAX_CHARS = 120;

export interface AgentGuide {
  historyDigest?: string[];
  [key: string]: unknown; // Allow for game-specific metadata
}

export interface AppendHistoryOptions {
  /**
   * If provided, replaces all existing historyDigest entries with this one summary string
   * before adding the new 'entry'. This is used to "collapse" a finished round into one line.
   */
  summarizePrevious?: string;
}

/**
 * Appends a new entry to the history digest.
 * If summarizePrevious is provided, it wipes the current history and replaces it with the summary
 * before appending the new entry.
 */
export function appendHistoryDigest<T extends AgentGuide>(
  agentGuide: T | undefined,
  entry: string,
  options?: AppendHistoryOptions
): T {
  const currentGuide = (agentGuide ?? {}) as T;
  let historyDigest: string[] = Array.isArray(currentGuide.historyDigest)
    ? [...currentGuide.historyDigest]
    : [];

  // 1. Handle Round Collapsing/Summarization
  if (options?.summarizePrevious) {
    historyDigest = [options.summarizePrevious];
  }

  const trimmedEntry = entry.trim();
  if (trimmedEntry) {
    // 2. Handle Entry Clipping
    const maxChars = HISTORY_DIGEST_MAX_CHARS;
    const clipped =
      trimmedEntry.length > maxChars
        ? `${trimmedEntry.slice(0, Math.max(maxChars - 3, 0))}...`
        : trimmedEntry;

    // 3. Append new entry
    historyDigest.push(clipped);
  }

  return {
    ...currentGuide,
    historyDigest: historyDigest.slice(-HISTORY_DIGEST_MAX_ENTRIES),
  };
}
