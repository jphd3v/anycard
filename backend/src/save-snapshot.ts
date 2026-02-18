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

export function buildGameSaveSnapshot(gameId: string): GameSaveSnapshot | null {
  const initialState = getInitialState(gameId);
  if (!initialState) return null;

  const buildInfo = getBackendBuildInfo();
  const events: PersistedGameEvent[] = getEvents(gameId).map((event) => {
    return Object.fromEntries(
      Object.entries(event).filter(([key]) => key !== "gameId")
    ) as PersistedGameEvent;
  });
  const executedIntents: PersistedExecutedIntent[] = getExecutedIntents(gameId);

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
