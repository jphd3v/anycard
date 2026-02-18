import type {
  GameSaveSnapshot,
  GameState,
  PersistedExecutedIntent,
  PersistedGameEvent,
} from "../../shared/schemas.js";
import { getBackendBuildInfo } from "./build-info.js";
import { buildGameSaveFormat } from "./save-fingerprint.js";
import { getEvents, getExecutedIntents, getInitialState } from "./state.js";

function buildExportInitialState(initialState: GameState): GameState {
  const cards = Object.fromEntries(
    Object.entries(initialState.cards).map(([cardId, card]) => {
      const cardWithoutLabel = { ...card };
      delete cardWithoutLabel.label;
      return [cardId, cardWithoutLabel];
    })
  ) as GameState["cards"];

  return {
    ...initialState,
    cards,
  };
}

function buildSnapshotPayload(
  initialState: GameState,
  events: PersistedGameEvent[],
  executedIntents: PersistedExecutedIntent[]
): GameSaveSnapshot {
  const buildInfo = getBackendBuildInfo();
  return {
    exportedAt: new Date().toISOString(),
    origin: {
      backendCommitHash: buildInfo.commitHash,
      backendCommitUnixTs: buildInfo.commitUnixTs,
    },
    format: buildGameSaveFormat(initialState),
    initialState: buildExportInitialState(initialState),
    events,
    ...(executedIntents.length > 0 ? { executedIntents } : {}),
  };
}

function stripGameIdFromEvents(
  gameEvents: { gameId?: string; [key: string]: unknown }[]
): PersistedGameEvent[] {
  return gameEvents.map((event) => {
    return Object.fromEntries(
      Object.entries(event).filter(([key]) => key !== "gameId")
    ) as PersistedGameEvent;
  });
}

export function buildGameSaveSnapshot(gameId: string): GameSaveSnapshot | null {
  const initialState = getInitialState(gameId);
  if (!initialState) return null;

  const events = stripGameIdFromEvents(getEvents(gameId));
  const executedIntents: PersistedExecutedIntent[] = getExecutedIntents(gameId);

  return buildSnapshotPayload(initialState, events, executedIntents);
}

/**
 * Build a snapshot by appending only the new events/intents to a previously
 * persisted snapshot. Returns `null` if the game no longer exists, or
 * `{ snapshot, eventCount, intentCount }` on success.
 *
 * If `previous` is `null` (first write), this behaves like a full snapshot.
 *
 * The `skip` flag is `true` when nothing has changed since the last persist,
 * allowing the caller to avoid a redundant Supabase write.
 */
export function buildDeltaGameSaveSnapshot(
  gameId: string,
  previous: { eventCount: number; intentCount: number } | null
): {
  snapshot: GameSaveSnapshot;
  eventCount: number;
  intentCount: number;
  skip: boolean;
} | null {
  const initialState = getInitialState(gameId);
  if (!initialState) return null;

  const allEvents = getEvents(gameId);
  const allIntents = getExecutedIntents(gameId);

  const prevEventCount = previous?.eventCount ?? 0;
  const prevIntentCount = previous?.intentCount ?? 0;

  // Nothing changed since last persist — skip the write
  if (
    previous !== null &&
    allEvents.length === prevEventCount &&
    allIntents.length === prevIntentCount
  ) {
    return {
      snapshot: null as unknown as GameSaveSnapshot, // not used when skip=true
      eventCount: allEvents.length,
      intentCount: allIntents.length,
      skip: true,
    };
  }

  const events = stripGameIdFromEvents(allEvents);
  const snapshot = buildSnapshotPayload(initialState, events, allIntents);

  return {
    snapshot,
    eventCount: allEvents.length,
    intentCount: allIntents.length,
    skip: false,
  };
}
