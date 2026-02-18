import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  GameSaveSnapshotSchema,
  type GameSaveSnapshot,
} from "../../../shared/schemas.js";
import { getEnvironmentConfig } from "../config.js";
import { buildGameSaveSnapshot } from "../save-snapshot.js";
import {
  registerPersistenceChangeListener,
  type PersistenceChangeType,
} from "../state.js";

export type PersistedRoomType = "demo" | "public" | "private";

export type SupabasePersistedGameRecord = {
  gameId: string;
  roomType: PersistedRoomType;
  snapshot: GameSaveSnapshot;
  persistedAt?: string;
  storage: "supabase";
};

type SupabaseSnapshotUpsertRow = {
  game_id: string;
  rules_id: string;
  room_type?: PersistedRoomType;
  snapshot: GameSaveSnapshot;
  updated_at: string;
};

type SupabaseSnapshotReadRow = {
  game_id?: unknown;
  room_type?: unknown;
  snapshot?: unknown;
  updated_at?: unknown;
};

type PendingChange = PersistenceChangeType;

type SupabaseAutosaveOptions = {
  resolveRoomType?: (gameId: string) => PersistedRoomType;
  onSnapshotPersisted?: (payload: {
    gameId: string;
    roomType: PersistedRoomType;
    persistedAt: string;
  }) => void;
  onSnapshotDeleted?: (payload: { gameId: string }) => void;
};

const KEEP_SNAPSHOTS_ON_DELETE = true;
const SUPABASE_MIGRATION_COMMAND = "npm run supabase:db:push";

function createSupabaseAutosaveClient(
  url: string,
  serviceRoleKey: string
): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function getSupabaseConfig(): {
  enabled: boolean;
  tableName: string;
  url?: string;
  serviceRoleKey?: string;
  disabledForTestEnv: boolean;
} {
  const config = getEnvironmentConfig();
  const disabledForTestEnv =
    config.isTestEnvironment && config.supabaseAutosaveEnabled;
  return {
    enabled: config.supabaseAutosaveEnabled && !config.isTestEnvironment,
    tableName: config.supabaseAutosaveTable,
    url: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
    disabledForTestEnv,
  };
}

function normalizeRoomType(value: unknown): PersistedRoomType {
  return value === "demo" || value === "public" || value === "private"
    ? value
    : "private";
}

function getErrorMessage(error: { message?: string }): string {
  return typeof error.message === "string" ? error.message.toLowerCase() : "";
}

function isMissingColumnError(
  error: {
    message?: string;
    code?: string;
  },
  columnName: string
): boolean {
  const message = getErrorMessage(error);
  if (
    message.includes(columnName) &&
    (message.includes("does not exist") || message.includes("could not find"))
  ) {
    return true;
  }
  return error.code === "PGRST204" && message.includes(columnName);
}

function isMissingRoomTypeColumnError(error: {
  message?: string;
  code?: string;
}): boolean {
  return isMissingColumnError(error, "room_type");
}

function isMissingSnapshotsTableError(error: {
  message?: string;
  code?: string;
}): boolean {
  const message = getErrorMessage(error);
  if (
    message.includes("game_snapshots") &&
    (message.includes("does not exist") || message.includes("could not find"))
  ) {
    return true;
  }
  return error.code === "PGRST205" && message.includes("game_snapshots");
}

type PreflightResult =
  | { ok: true; supportsRoomTypeColumn: boolean }
  | { ok: false };

async function runAutosaveSchemaPreflight(
  supabase: SupabaseClient,
  tableName: string
): Promise<PreflightResult> {
  const checkWithRoomType = await supabase
    .from(tableName)
    .select("game_id, rules_id, snapshot, updated_at, room_type")
    .limit(1);

  if (!checkWithRoomType.error) {
    return { ok: true, supportsRoomTypeColumn: true };
  }

  if (isMissingRoomTypeColumnError(checkWithRoomType.error)) {
    const fallback = await supabase
      .from(tableName)
      .select("game_id, rules_id, snapshot, updated_at")
      .limit(1);

    if (!fallback.error) {
      return { ok: true, supportsRoomTypeColumn: false };
    }

    if (isMissingSnapshotsTableError(fallback.error)) {
      console.warn(
        `[Autosave] Supabase table '${tableName}' was not found. ` +
          `Run '${SUPABASE_MIGRATION_COMMAND}' before starting dev server. ` +
          "Autosave disabled."
      );
      return { ok: false };
    }

    console.warn(
      "[Autosave] Supabase schema preflight failed. table=%s autosave disabled.",
      tableName,
      fallback.error
    );
    return { ok: false };
  }

  if (isMissingSnapshotsTableError(checkWithRoomType.error)) {
    console.warn(
      `[Autosave] Supabase table '${tableName}' was not found. ` +
        `Run '${SUPABASE_MIGRATION_COMMAND}' before starting dev server. ` +
        "Autosave disabled."
    );
    return { ok: false };
  }

  console.warn(
    "[Autosave] Supabase schema preflight failed. table=%s autosave disabled.",
    tableName,
    checkWithRoomType.error
  );
  return { ok: false };
}

export async function assertSupabaseAutosaveSchemaOrThrow(): Promise<void> {
  const config = getSupabaseConfig();
  if (!config.enabled) {
    return;
  }
  if (!config.url || !config.serviceRoleKey) {
    return;
  }

  const supabase = createSupabaseAutosaveClient(
    config.url,
    config.serviceRoleKey
  );
  const preflight = await runAutosaveSchemaPreflight(
    supabase,
    config.tableName
  );
  if (!preflight.ok) {
    throw new Error(
      `[Autosave] Required Supabase schema is unavailable. table='${config.tableName}' run '${SUPABASE_MIGRATION_COMMAND}'.`
    );
  }
  if (!preflight.supportsRoomTypeColumn) {
    throw new Error(
      `[Autosave] Required Supabase column missing. table='${config.tableName}' column='room_type' run '${SUPABASE_MIGRATION_COMMAND}'.`
    );
  }
}

export async function fetchPersistedGamesFromSupabase(): Promise<
  SupabasePersistedGameRecord[]
> {
  const config = getSupabaseConfig();
  if (!config.enabled) {
    return [];
  }
  if (!config.url || !config.serviceRoleKey) {
    return [];
  }

  const supabase = createSupabaseAutosaveClient(
    config.url,
    config.serviceRoleKey
  );

  let rows: SupabaseSnapshotReadRow[] | null = null;
  let queryError: unknown = null;

  {
    const { data, error } = await supabase
      .from(config.tableName)
      .select("game_id, room_type, snapshot, updated_at")
      .order("updated_at", { ascending: false });

    if (!error) {
      rows = (Array.isArray(data) ? data : []) as SupabaseSnapshotReadRow[];
    } else {
      queryError = error;
      const missingRoomType = isMissingRoomTypeColumnError(error);

      if (missingRoomType) {
        const fallback = await supabase
          .from(config.tableName)
          .select("game_id, snapshot, updated_at")
          .order("updated_at", { ascending: false });

        if (!fallback.error) {
          console.warn(
            "[Autosave] Supabase schema fallback active during restore. table=%s missing_column=room_type run='%s'",
            config.tableName,
            SUPABASE_MIGRATION_COMMAND
          );
          rows = (
            Array.isArray(fallback.data) ? fallback.data : []
          ) as SupabaseSnapshotReadRow[];
          queryError = null;
        } else {
          queryError = fallback.error;
        }
      }
    }
  }

  if (queryError) {
    const errorLike =
      queryError && typeof queryError === "object"
        ? (queryError as { message?: string; code?: string })
        : {};
    if (isMissingSnapshotsTableError(errorLike)) {
      console.warn(
        `[Autosave] Supabase table '${config.tableName}' was not found. ` +
          `Run '${SUPABASE_MIGRATION_COMMAND}' and restart backend.`
      );
      return [];
    }
    console.warn("[Autosave] Failed to fetch persisted snapshots", queryError);
    return [];
  }

  const records: SupabasePersistedGameRecord[] = [];
  for (const row of rows ?? []) {
    const gameId = typeof row.game_id === "string" ? row.game_id : "";
    if (!gameId) {
      continue;
    }

    const parsedSnapshot = GameSaveSnapshotSchema.safeParse(row.snapshot);
    if (!parsedSnapshot.success) {
      console.warn("[Autosave] Dropped invalid persisted snapshot", {
        gameId,
        issues: parsedSnapshot.error.issues.length,
      });
      continue;
    }

    const persistedAt =
      typeof row.updated_at === "string" &&
      Number.isFinite(Date.parse(row.updated_at))
        ? row.updated_at
        : undefined;

    records.push({
      gameId,
      roomType: normalizeRoomType(row.room_type),
      snapshot: parsedSnapshot.data,
      persistedAt,
      storage: "supabase",
    });
  }

  return records;
}

export async function initSupabaseAutosave(
  options: SupabaseAutosaveOptions = {}
): Promise<void> {
  const config = getSupabaseConfig();
  if (!config.enabled) {
    if (config.disabledForTestEnv) {
      console.log("[Autosave] Disabled in test environment.");
    }
    console.log("[Autosave] Supabase autosave disabled.");
    return;
  }

  if (!config.url || !config.serviceRoleKey) {
    console.warn(
      "[Autosave] Supabase autosave is enabled but credentials are missing; feature disabled."
    );
    return;
  }

  const tableName = config.tableName;
  const supabase = createSupabaseAutosaveClient(
    config.url,
    config.serviceRoleKey
  );

  const preflight = await runAutosaveSchemaPreflight(supabase, tableName);
  if (!preflight.ok) {
    return;
  }
  if (!preflight.supportsRoomTypeColumn) {
    console.warn(
      `[Autosave] Supabase table '${tableName}' is missing column 'room_type'. ` +
        `Run '${SUPABASE_MIGRATION_COMMAND}' to apply latest migrations. ` +
        "Continuing without room_type persistence."
    );
  }
  console.log(
    "[Autosave] Supabase schema preflight ok. table=%s room_type=%s",
    tableName,
    preflight.supportsRoomTypeColumn ? "present" : "missing (compat mode)"
  );

  const pendingChanges = new Map<string, PendingChange>();
  const inFlight = new Set<string>();
  let supportsRoomTypeColumn = preflight.supportsRoomTypeColumn;

  const resolveRoomType =
    options.resolveRoomType ?? (() => "private" as PersistedRoomType);

  const setPendingChange = (
    gameId: string,
    changeType: PendingChange
  ): void => {
    if (changeType === "delete" && KEEP_SNAPSHOTS_ON_DELETE) {
      return;
    }

    const previous = pendingChanges.get(gameId);
    if (previous === "delete" || changeType === "delete") {
      pendingChanges.set(gameId, "delete");
      return;
    }
    pendingChanges.set(gameId, "upsert");
  };

  const upsertSnapshot = async (gameId: string): Promise<void> => {
    const snapshot = buildGameSaveSnapshot(gameId);
    if (!snapshot) {
      if (!KEEP_SNAPSHOTS_ON_DELETE) {
        await deleteSnapshot(gameId);
      }
      return;
    }

    const persistedAt = new Date().toISOString();
    const roomType = resolveRoomType(gameId);

    const row: SupabaseSnapshotUpsertRow = {
      game_id: gameId,
      rules_id: snapshot.initialState.rulesId,
      snapshot,
      updated_at: persistedAt,
    };
    if (supportsRoomTypeColumn) {
      row.room_type = roomType;
    }

    let { error } = await supabase
      .from(tableName)
      .upsert(row, { onConflict: "game_id" });

    if (error && supportsRoomTypeColumn) {
      const missingRoomType = isMissingRoomTypeColumnError(error);
      if (missingRoomType) {
        supportsRoomTypeColumn = false;
        const retryRow: SupabaseSnapshotUpsertRow = { ...row };
        delete retryRow.room_type;
        const retry = await supabase
          .from(tableName)
          .upsert(retryRow, { onConflict: "game_id" });
        error = retry.error;
      }
    }

    if (error) {
      throw error;
    }

    options.onSnapshotPersisted?.({
      gameId,
      roomType,
      persistedAt,
    });
  };

  const deleteSnapshot = async (gameId: string): Promise<void> => {
    const { error } = await supabase
      .from(tableName)
      .delete()
      .eq("game_id", gameId);
    if (error) {
      throw error;
    }
    options.onSnapshotDeleted?.({ gameId });
  };

  const flushQueue = async (gameId: string): Promise<void> => {
    if (inFlight.has(gameId)) return;
    inFlight.add(gameId);

    try {
      while (pendingChanges.has(gameId)) {
        const nextChange = pendingChanges.get(gameId);
        pendingChanges.delete(gameId);
        if (!nextChange) continue;

        try {
          if (nextChange === "delete") {
            await deleteSnapshot(gameId);
          } else {
            await upsertSnapshot(gameId);
          }
        } catch (error) {
          console.warn("[Autosave] Supabase write failed", {
            gameId,
            changeType: nextChange,
            error,
          });
        }
      }
    } finally {
      inFlight.delete(gameId);
    }
  };

  registerPersistenceChangeListener((gameId, changeType) => {
    setPendingChange(gameId, changeType);
    void flushQueue(gameId);
  });

  console.log(
    `[Autosave] Supabase autosave enabled. table=${tableName} writes=event-driven retainOnDelete=${KEEP_SNAPSHOTS_ON_DELETE ? "true" : "false"}`
  );
}
