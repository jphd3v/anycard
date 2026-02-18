import type {
  GameEvent,
  GameLogEntry,
  GameState,
  PersistedExecutedIntent,
} from "../../shared/schemas.js";
import { GameLogEntrySchema } from "../../shared/schemas.js";
import type { GamePlugin } from "./rules/interface.js";
import { applyEvent } from "./state.js";
import { formatCard } from "./util/card-notation.js";
import { isPileVisibleToPlayer } from "./visibility.js";

function getPlayerLabel(state: GameState, playerId: string | null): string {
  if (!playerId) return "System";
  const player = state.players.find((entry) => entry.id === playerId);
  return player?.name && player.name.trim().length > 0 ? player.name : playerId;
}

function getPileLabel(state: GameState, pileId: string): string {
  const overrideLabel = state.pileProperties?.[pileId]?.label;
  if (typeof overrideLabel === "string" && overrideLabel.trim().length > 0) {
    return overrideLabel;
  }
  return pileId;
}

function describeCard(state: GameState, cardId: number): string {
  const card = state.cards[cardId];
  if (!card) return `#${cardId}`;
  return formatCard(card.rank, card.suit);
}

function describeCardBatch(state: GameState, cardIds: number[]): string {
  if (cardIds.length === 0) return "";
  const labels = cardIds.map((cardId) => describeCard(state, cardId));
  if (labels.length <= 4) {
    return labels.join(", ");
  }
  const preview = labels.slice(0, 3).join(", ");
  return `${preview}, +${labels.length - 3} more`;
}

function isPileVisibleToViewer(
  state: GameState,
  pileId: string,
  viewerId?: string
): boolean {
  if (!viewerId) return true;
  const pile = state.piles[pileId];
  if (!pile) return false;
  return isPileVisibleToPlayer(pile, viewerId);
}

function canViewerSeeMovedCards(
  state: GameState,
  event: Extract<GameEvent, { type: "move-cards" }>,
  viewerId?: string
): boolean {
  if (!viewerId) return true;
  return (
    isPileVisibleToViewer(state, event.fromPileId, viewerId) ||
    isPileVisibleToViewer(state, event.toPileId, viewerId)
  );
}

const MIN_VALID_EVENT_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_VALID_EVENT_TIMESTAMP_MS = Date.UTC(2100, 0, 1);

function eventTimestampToIso(eventId: number): string | undefined {
  if (!Number.isFinite(eventId)) return undefined;
  const ts = Math.trunc(eventId);
  if (ts < MIN_VALID_EVENT_TIMESTAMP_MS || ts > MAX_VALID_EVENT_TIMESTAMP_MS) {
    return undefined;
  }
  return new Date(ts).toISOString();
}

function readNumberField(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[key];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) return null;
  return candidate;
}

function readStringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[key];
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRecapEntries(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const recap = (value as Record<string, unknown>).recap;
  if (!Array.isArray(recap)) return [];
  return recap
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function detectRoundMessages(previous: unknown, next: unknown): string[] {
  const markers: Array<{ key: string; label: string }> = [
    { key: "dealNumber", label: "Deal" },
    { key: "roundNumber", label: "Round" },
    { key: "handNumber", label: "Hand" },
  ];
  const out: string[] = [];

  for (const marker of markers) {
    const previousValue = readNumberField(previous, marker.key);
    const nextValue = readNumberField(next, marker.key);
    if (nextValue == null) continue;
    if (previousValue == null || previousValue !== nextValue) {
      out.push(`${marker.label} ${nextValue} started.`);
    }
  }

  const previousResult = readStringField(previous, "result");
  const nextResult = readStringField(next, "result");
  if (nextResult && nextResult !== previousResult) {
    out.push(nextResult);
  }

  return out;
}

function detectRecapMessages(previous: unknown, next: unknown): string[] {
  const previousRecap = readRecapEntries(previous);
  const nextRecap = readRecapEntries(next);
  if (nextRecap.length === 0) return [];
  if (nextRecap.length <= previousRecap.length) return [];

  const hasPrefix = previousRecap.every(
    (entry, index) => nextRecap[index] === entry
  );
  if (!hasPrefix) {
    return [nextRecap[nextRecap.length - 1]];
  }
  return nextRecap.slice(previousRecap.length);
}

function resolveActionIntentLabel(state: GameState, actionId: string): string {
  const actionCell = state.actions?.cells?.find((cell) => cell.id === actionId);
  const label =
    typeof actionCell?.label === "string" ? actionCell.label.trim() : "";
  if (label.length > 0) return label;
  return actionId;
}

function buildGenericGameLog(
  initialState: GameState,
  events: GameEvent[],
  importedEventCount: number,
  executedIntents: PersistedExecutedIntent[],
  importedExecutedIntentCount: number,
  viewerId?: string
): GameLogEntry[] {
  const entries: GameLogEntry[] = [];
  const addEntry = (entry: Omit<GameLogEntry, "index">) => {
    entries.push({
      ...entry,
      index: entries.length,
    });
  };

  let state = initialState;
  let currentPlayer = initialState.currentPlayer;
  let currentTurn = currentPlayer ? 1 : 0;
  let previousRulesState = initialState.rulesState;
  const actionIntents = executedIntents.filter(
    (intent): intent is Extract<PersistedExecutedIntent, { type: "action" }> =>
      intent.type === "action"
  );
  let nextActionIntentIndex = 0;
  let currentActionGroup: {
    actorId: string | null;
    turnNumber: number;
    timestamp?: string;
    intentTimestampMs: number | null;
    imported: boolean;
    message: string;
    hasExplicitActionEntry: boolean;
    hasSeenNonAnnounceEvent: boolean;
  } | null = null;
  const setupTimestamp =
    events.length > 0 ? eventTimestampToIso(events[0].id) : undefined;
  const setupImported = importedEventCount > 0;

  addEntry({
    turnNumber: 0,
    kind: "setup",
    message: `Game started: ${initialState.gameName}.`,
    timestamp: setupTimestamp,
    imported: setupImported,
  });

  if (currentPlayer) {
    addEntry({
      turnNumber: currentTurn,
      kind: "turn",
      message: `Turn started: ${getPlayerLabel(state, currentPlayer)}.`,
      actorId: currentPlayer,
      eventType: "set-current-player",
      timestamp: setupTimestamp,
      imported: setupImported,
    });
  }

  const startActionGroup = (
    event: GameEvent,
    eventTimestamp: string | undefined,
    isImportedEvent: boolean
  ) => {
    if (currentActionGroup) return;
    const matchingIntent = actionIntents[nextActionIntentIndex];
    const hasMatchingIntent = matchingIntent?.type === "action";
    if (hasMatchingIntent) {
      nextActionIntentIndex += 1;
    }
    const actorId =
      matchingIntent?.playerId ??
      event.initiatedByPlayerId ??
      event.playerId ??
      currentPlayer ??
      null;
    const turnNumber = matchingIntent?.turnNumber ?? currentTurn;
    const timestamp = matchingIntent?.timestamp ?? eventTimestamp;
    const intentTimestampMs = matchingIntent
      ? Date.parse(matchingIntent.timestamp)
      : null;
    const message = matchingIntent
      ? resolveActionIntentLabel(state, matchingIntent.action)
      : "Action executed.";
    const imported = hasMatchingIntent
      ? nextActionIntentIndex <= Math.max(0, importedExecutedIntentCount)
      : isImportedEvent;

    currentActionGroup = {
      actorId,
      turnNumber,
      timestamp,
      intentTimestampMs: Number.isFinite(intentTimestampMs)
        ? intentTimestampMs
        : null,
      imported,
      message,
      hasExplicitActionEntry: false,
      hasSeenNonAnnounceEvent: false,
    };
  };

  const flushActionGroup = () => {
    if (!currentActionGroup) return;
    if (!currentActionGroup.hasExplicitActionEntry) {
      addEntry({
        turnNumber: currentActionGroup.turnNumber,
        kind: "action",
        message: currentActionGroup.message,
        actorId: currentActionGroup.actorId,
        eventType: "action-intent",
        timestamp: currentActionGroup.timestamp,
        imported: currentActionGroup.imported,
      });
    }
    currentActionGroup = null;
  };

  const getCurrentActionGroupIntentTimestampMs = (): number | null =>
    currentActionGroup ? currentActionGroup.intentTimestampMs : null;

  const markCurrentActionGroupHasExplicitEntry = () => {
    if (currentActionGroup) {
      currentActionGroup.hasExplicitActionEntry = true;
    }
  };

  const markCurrentActionGroupHasSeenNonAnnounceEvent = () => {
    if (currentActionGroup) {
      currentActionGroup.hasSeenNonAnnounceEvent = true;
    }
  };

  const canTreatCurrentAnnounceAsAction = (): boolean => {
    return (
      currentActionGroup !== null &&
      !currentActionGroup.hasExplicitActionEntry &&
      !currentActionGroup.hasSeenNonAnnounceEvent
    );
  };

  for (const [eventIndex, event] of events.entries()) {
    const eventTimestamp = eventTimestampToIso(event.id);
    const isImported = eventIndex < importedEventCount;
    const isActionIntentEvent = event.initiatedByIntentType === "action";
    if (isActionIntentEvent) {
      const activeIntentTimestampMs = getCurrentActionGroupIntentTimestampMs();
      if (
        activeIntentTimestampMs != null &&
        Number.isFinite(event.id) &&
        event.id > activeIntentTimestampMs
      ) {
        flushActionGroup();
      }
      startActionGroup(event, eventTimestamp, isImported);
    } else {
      flushActionGroup();
    }
    if (isActionIntentEvent && event.type !== "announce") {
      markCurrentActionGroupHasSeenNonAnnounceEvent();
    }
    switch (event.type) {
      case "move-cards": {
        const actorId = event.playerId ?? currentPlayer;
        const actor =
          event.executorRole === "system"
            ? "System"
            : getPlayerLabel(state, actorId);
        const fromPile = getPileLabel(state, event.fromPileId);
        const toPile = getPileLabel(state, event.toPileId);
        const cardSummary = describeCardBatch(state, event.cardIds);
        const cardsVisible = canViewerSeeMovedCards(state, event, viewerId);
        let message: string;
        if (cardsVisible) {
          message =
            event.cardIds.length === 1
              ? `${actor} moved ${cardSummary} from ${fromPile} to ${toPile}.`
              : `${actor} moved ${event.cardIds.length} cards from ${fromPile} to ${toPile} (${cardSummary}).`;
        } else {
          message =
            event.cardIds.length === 1
              ? `${actor} moved a hidden card from ${fromPile} to ${toPile}.`
              : `${actor} moved ${event.cardIds.length} hidden cards from ${fromPile} to ${toPile}.`;
        }
        addEntry({
          turnNumber: currentTurn,
          kind: "move",
          message,
          actorId: event.executorRole === "system" ? null : (actorId ?? null),
          eventType: event.type,
          timestamp: eventTimestamp,
          imported: isImported,
        });
        break;
      }
      case "announce": {
        const announceKind = event.announceKind;
        let logKind: GameLogEntry["kind"];

        if (announceKind === "action") {
          logKind = "action";
          markCurrentActionGroupHasExplicitEntry();
        } else if (announceKind === "score") {
          logKind = "score";
        } else if (announceKind === "announce") {
          logKind = "announce";
        } else {
          // Backward-compatible fallback for legacy rule modules that
          // haven't started emitting explicit announceKind yet.
          const isActionAnnounce = canTreatCurrentAnnounceAsAction();
          if (isActionAnnounce) {
            markCurrentActionGroupHasExplicitEntry();
          }
          logKind = isActionAnnounce ? "action" : "announce";
        }
        addEntry({
          turnNumber: currentTurn,
          kind: logKind,
          message: event.text,
          actorId: event.playerId,
          eventType: event.type,
          timestamp: eventTimestamp,
          imported: isImported,
        });
        break;
      }
      case "set-rules-state": {
        const roundMessages = detectRoundMessages(
          previousRulesState,
          event.rulesState
        );
        for (const message of roundMessages) {
          addEntry({
            turnNumber: currentTurn,
            kind: "round",
            message,
            actorId: event.playerId,
            eventType: event.type,
            timestamp: eventTimestamp,
            imported: isImported,
          });
        }

        const recapMessages = detectRecapMessages(
          previousRulesState,
          event.rulesState
        );
        for (const recapMessage of recapMessages) {
          addEntry({
            turnNumber: currentTurn,
            kind: "recap",
            message: recapMessage,
            actorId: event.playerId,
            eventType: event.type,
            timestamp: eventTimestamp,
            imported: isImported,
          });
        }

        previousRulesState = event.rulesState;
        break;
      }
      case "set-scoreboards": {
        break;
      }
      case "set-current-player": {
        if (event.player !== currentPlayer) {
          currentPlayer = event.player;
          if (currentPlayer) {
            currentTurn = currentTurn === 0 ? 1 : currentTurn + 1;
            addEntry({
              turnNumber: currentTurn,
              kind: "turn",
              message: `Turn started: ${getPlayerLabel(state, currentPlayer)}.`,
              actorId: currentPlayer,
              eventType: event.type,
              timestamp: eventTimestamp,
              imported: isImported,
            });
          } else {
            addEntry({
              turnNumber: currentTurn,
              kind: "system",
              message: "Turn order cleared.",
              actorId: event.playerId,
              eventType: event.type,
              timestamp: eventTimestamp,
              imported: isImported,
            });
          }
        }
        break;
      }
      case "set-winner": {
        const winnerLabel = event.winner
          ? getPlayerLabel(state, event.winner)
          : "No winner";
        addEntry({
          turnNumber: currentTurn,
          kind: "winner",
          message: `Winner: ${winnerLabel}.`,
          actorId: event.winner,
          eventType: event.type,
          timestamp: eventTimestamp,
          imported: isImported,
        });
        break;
      }
      case "fatal-error":
        addEntry({
          turnNumber: currentTurn,
          kind: "error",
          message: event.message,
          actorId: event.playerId,
          eventType: event.type,
          timestamp: eventTimestamp,
          imported: isImported,
        });
        break;
      default:
        break;
    }

    state = applyEvent(state, event);
  }
  flushActionGroup();

  return entries;
}

function normalizeCustomEntries(
  entries: GameLogEntry[]
): GameLogEntry[] | null {
  const normalized: GameLogEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    const parsed = GameLogEntrySchema.safeParse({
      ...entry,
      index,
    });
    if (!parsed.success) {
      return null;
    }
    normalized.push(parsed.data);
  }
  return normalized;
}

export function buildDeterministicGameLog(
  initialState: GameState,
  events: GameEvent[],
  plugin?: GamePlugin,
  options?: {
    importedEventCount?: number;
    importedExecutedIntentCount?: number;
    executedIntents?: PersistedExecutedIntent[];
    viewerId?: string;
  }
): GameLogEntry[] {
  const importedEventCount = Math.max(
    0,
    Math.trunc(options?.importedEventCount ?? 0)
  );
  const importedExecutedIntentCount = Math.max(
    0,
    Math.trunc(options?.importedExecutedIntentCount ?? 0)
  );
  const executedIntents = options?.executedIntents ?? [];
  const genericEntries = buildGenericGameLog(
    initialState,
    events,
    importedEventCount,
    executedIntents,
    importedExecutedIntentCount,
    options?.viewerId
  );
  const customFormatter = plugin?.ruleModule.formatGameLog;
  if (!customFormatter) return genericEntries;

  try {
    const customEntries = customFormatter(
      initialState,
      events,
      genericEntries,
      {
        importedEventCount,
        importedExecutedIntentCount,
        executedIntents,
        viewerId: options?.viewerId,
      }
    );
    if (!customEntries) return genericEntries;
    const normalized = normalizeCustomEntries(customEntries);
    if (!normalized) {
      console.warn(
        "[Game Log] Invalid custom log entries for rulesId=%s; using generic formatter.",
        initialState.rulesId
      );
      return genericEntries;
    }
    return normalized;
  } catch (error) {
    console.warn(
      "[Game Log] Custom formatter failed for rulesId=%s; using generic formatter.",
      initialState.rulesId,
      error
    );
    return genericEntries;
  }
}
