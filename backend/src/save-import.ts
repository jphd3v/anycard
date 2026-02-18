import type {
  PersistedExecutedIntent,
  GameSaveSnapshot,
  PersistedGameEvent,
} from "../../shared/schemas.js";
import {
  GAME_SAVE_EVENT_PAYLOAD_SCHEMA_HASH,
  GAME_SAVE_HASH_ALGORITHM,
  GAME_SAVE_SCHEMA_HASH,
  GameSaveFormatSchema,
  GameSaveOriginSchema,
  GameSaveSnapshotSchema,
  GameStateSchema,
  MAX_GAME_SAVE_EVENTS,
  PersistedGameEventSchema,
  PersistedExecutedIntentSchema,
} from "../../shared/schemas.js";
import { computeRulesSchemaHash } from "./save-fingerprint.js";

type ParseSaveImportResult =
  | {
      ok: true;
      parsed: {
        snapshot: GameSaveSnapshot;
        mode: "strict" | "lax";
        warnings: string[];
      };
    }
  | {
      ok: false;
      message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toIsoDatetimeOrNow(value: unknown): {
  iso: string;
  recovered: boolean;
} {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return { iso: new Date(parsed).toISOString(), recovered: false };
    }
  }
  return { iso: new Date().toISOString(), recovered: true };
}

function parsePersistedEventsLax(raw: unknown): {
  events: PersistedGameEvent[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const sourceArray = Array.isArray(raw) ? raw : [];

  if (!Array.isArray(raw)) {
    warnings.push("Missing events array; defaulted to empty list.");
  }

  const maxed = sourceArray.slice(0, MAX_GAME_SAVE_EVENTS);
  if (sourceArray.length > MAX_GAME_SAVE_EVENTS) {
    warnings.push(
      `Event list truncated to ${MAX_GAME_SAVE_EVENTS} entries during import.`
    );
  }

  const events: PersistedGameEvent[] = [];
  let dropped = 0;
  for (const event of maxed) {
    const parsedEvent = PersistedGameEventSchema.safeParse(event);
    if (parsedEvent.success) {
      events.push(parsedEvent.data);
    } else {
      dropped += 1;
    }
  }

  if (dropped > 0) {
    warnings.push(`Dropped ${dropped} invalid event(s) during recovery parse.`);
  }

  return { events, warnings };
}

function parseExecutedIntentsLax(raw: unknown): {
  executedIntents: PersistedExecutedIntent[] | undefined;
  warnings: string[];
} {
  if (raw == null) {
    return { executedIntents: undefined, warnings: [] };
  }

  const warnings: string[] = [];
  if (!Array.isArray(raw)) {
    warnings.push("Dropped invalid executedIntents payload.");
    return { executedIntents: undefined, warnings };
  }

  const maxed = raw.slice(0, MAX_GAME_SAVE_EVENTS);
  if (raw.length > MAX_GAME_SAVE_EVENTS) {
    warnings.push(
      `Executed intents truncated to ${MAX_GAME_SAVE_EVENTS} entries during import.`
    );
  }

  const executedIntents: PersistedExecutedIntent[] = [];
  let dropped = 0;
  for (const item of maxed) {
    const parsed = PersistedExecutedIntentSchema.safeParse(item);
    if (parsed.success) {
      executedIntents.push(parsed.data);
    } else {
      dropped += 1;
    }
  }

  if (dropped > 0) {
    warnings.push(
      `Dropped ${dropped} invalid executed intent(s) during recovery parse.`
    );
  }

  return { executedIntents, warnings };
}

function collectFormatWarnings(snapshot: GameSaveSnapshot): string[] {
  const warnings: string[] = [];
  const format = snapshot.format;
  if (!format) {
    warnings.push("Save is missing format fingerprints; treated as legacy.");
    return warnings;
  }

  if (format.hashAlgorithm !== GAME_SAVE_HASH_ALGORITHM) {
    warnings.push(
      `Hash algorithm mismatch (${format.hashAlgorithm} vs ${GAME_SAVE_HASH_ALGORITHM}).`
    );
  }
  if (format.saveSchemaHash !== GAME_SAVE_SCHEMA_HASH) {
    warnings.push("Save schema hash differs from current runtime.");
  }
  if (format.eventPayloadSchemaHash !== GAME_SAVE_EVENT_PAYLOAD_SCHEMA_HASH) {
    warnings.push("Event payload schema hash differs from current runtime.");
  }

  const expectedRulesHash = computeRulesSchemaHash(snapshot.initialState);
  if (format.rulesSchemaHash !== expectedRulesHash) {
    warnings.push("Rules schema hash differs from current runtime.");
  }

  return warnings;
}

function parseSaveSnapshotLax(rawSnapshot: unknown): ParseSaveImportResult {
  if (!isRecord(rawSnapshot)) {
    return {
      ok: false,
      message: "Invalid save payload: expected JSON object at root.",
    };
  }

  const initialStateCandidate =
    rawSnapshot.initialState ?? rawSnapshot.state ?? rawSnapshot.initial;
  const parsedInitial = GameStateSchema.safeParse(initialStateCandidate);
  if (!parsedInitial.success) {
    const firstIssue = parsedInitial.error.issues[0];
    const issuePath = firstIssue?.path?.join(".") ?? "initialState";
    const issueMessage = firstIssue?.message ?? "invalid initial state";
    return {
      ok: false,
      message: `Invalid save payload at ${issuePath}: ${issueMessage}`,
    };
  }

  const { iso: exportedAt, recovered: recoveredExportedAt } =
    toIsoDatetimeOrNow(rawSnapshot.exportedAt);
  const parsedOrigin = GameSaveOriginSchema.safeParse(rawSnapshot.origin);
  const parsedFormat = GameSaveFormatSchema.safeParse(rawSnapshot.format);
  const { events, warnings: eventWarnings } = parsePersistedEventsLax(
    rawSnapshot.events ?? rawSnapshot.eventLog
  );
  const { executedIntents, warnings: executedIntentWarnings } =
    parseExecutedIntentsLax(rawSnapshot.executedIntents);

  const warnings: string[] = [...eventWarnings, ...executedIntentWarnings];
  if (recoveredExportedAt) {
    warnings.push("Recovered exportedAt timestamp.");
  }
  if (rawSnapshot.origin != null && !parsedOrigin.success) {
    warnings.push("Dropped invalid origin metadata.");
  }
  if (rawSnapshot.format != null && !parsedFormat.success) {
    warnings.push("Dropped invalid format fingerprints.");
  }

  const candidateSnapshot: GameSaveSnapshot = {
    exportedAt,
    ...(parsedOrigin.success ? { origin: parsedOrigin.data } : {}),
    ...(parsedFormat.success ? { format: parsedFormat.data } : {}),
    initialState: parsedInitial.data,
    events,
    ...(executedIntents ? { executedIntents } : {}),
  };

  const parsedSnapshot = GameSaveSnapshotSchema.safeParse(candidateSnapshot);
  if (!parsedSnapshot.success) {
    return {
      ok: false,
      message: "Recovered save payload is still invalid after lax parsing.",
    };
  }

  return {
    ok: true,
    parsed: {
      snapshot: parsedSnapshot.data,
      mode: "lax",
      warnings: [
        "Loaded using best-effort recovery parser.",
        ...warnings,
        ...collectFormatWarnings(parsedSnapshot.data),
      ],
    },
  };
}

export function parseSaveSnapshotForImport(
  rawSnapshot: unknown
): ParseSaveImportResult {
  const strict = GameSaveSnapshotSchema.safeParse(rawSnapshot);
  if (strict.success) {
    return {
      ok: true,
      parsed: {
        snapshot: strict.data,
        mode: "strict",
        warnings: collectFormatWarnings(strict.data),
      },
    };
  }

  return parseSaveSnapshotLax(rawSnapshot);
}
