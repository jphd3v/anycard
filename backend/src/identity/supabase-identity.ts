import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnvironmentConfig } from "../config.js";

export type VerifiedIdentity = {
  userId: string;
  email: string | null;
};

export type SeatClaimRecord = {
  gameId: string;
  seatId: string;
  ownerUserId: string;
  avatarEmoji: string | null;
  disconnectedAt: string | null;
};

type SeatClaimRow = {
  game_id?: unknown;
  seat_id?: unknown;
  owner_user_id?: unknown;
  avatar_emoji?: unknown;
  disconnected_at?: unknown;
};

type UserProfileRow = {
  user_id?: unknown;
  avatar_emoji?: unknown;
};

type GameHostRow = {
  game_id?: unknown;
  host_user_id?: unknown;
};

const DEFAULT_RELEASE_TIMEOUT_SECONDS = 600;
const MIN_RELEASE_TIMEOUT_SECONDS = 30;
const MAX_RELEASE_TIMEOUT_SECONDS = 24 * 60 * 60;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;
const MIN_CLEANUP_INTERVAL_MS = 10_000;

function parseIntegerEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

const releaseTimeoutSeconds = clamp(
  parseIntegerEnv(
    process.env.SEAT_CLAIM_RELEASE_TIMEOUT_SECONDS,
    DEFAULT_RELEASE_TIMEOUT_SECONDS
  ),
  MIN_RELEASE_TIMEOUT_SECONDS,
  MAX_RELEASE_TIMEOUT_SECONDS
);

const cleanupIntervalMs = Math.max(
  parseIntegerEnv(
    process.env.SEAT_CLAIM_CLEANUP_INTERVAL_MS,
    DEFAULT_CLEANUP_INTERVAL_MS
  ),
  MIN_CLEANUP_INTERVAL_MS
);

function isIdentityConfigured(): boolean {
  const config = getEnvironmentConfig();
  return Boolean(
    config.supabaseIdentityEnabled &&
    config.supabaseUrl &&
    config.supabaseSecretKey
  );
}

let identityClient: SupabaseClient | null = null;

function getIdentityClient(): SupabaseClient | null {
  if (!isIdentityConfigured()) return null;
  if (identityClient) return identityClient;

  const config = getEnvironmentConfig();
  if (!config.supabaseUrl || !config.supabaseSecretKey) {
    return null;
  }

  identityClient = createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return identityClient;
}

function mapSeatClaimRow(row: SeatClaimRow): SeatClaimRecord | null {
  if (
    typeof row.game_id !== "string" ||
    typeof row.seat_id !== "string" ||
    typeof row.owner_user_id !== "string"
  ) {
    return null;
  }
  return {
    gameId: row.game_id,
    seatId: row.seat_id,
    ownerUserId: row.owner_user_id,
    avatarEmoji: typeof row.avatar_emoji === "string" ? row.avatar_emoji : null,
    disconnectedAt:
      typeof row.disconnected_at === "string" ? row.disconnected_at : null,
  };
}

function mapGameHostRow(row: GameHostRow): {
  gameId: string;
  hostUserId: string;
} | null {
  if (typeof row.game_id !== "string" || typeof row.host_user_id !== "string") {
    return null;
  }
  return {
    gameId: row.game_id,
    hostUserId: row.host_user_id,
  };
}

function isDuplicateConstraintError(error: {
  code?: string;
  message?: string;
}): boolean {
  if (error.code === "23505") return true;
  const message = (error.message ?? "").toLowerCase();
  return message.includes("duplicate key");
}

function isClaimExpired(disconnectedAt: string | null): boolean {
  if (!disconnectedAt) return false;
  const time = Date.parse(disconnectedAt);
  if (!Number.isFinite(time)) return false;
  return Date.now() - time > releaseTimeoutSeconds * 1000;
}

export function isSupabaseIdentityEnabled(): boolean {
  return isIdentityConfigured();
}

export function getSeatClaimReleaseTimeoutSeconds(): number {
  return releaseTimeoutSeconds;
}

export function getSeatClaimCleanupIntervalMs(): number {
  return cleanupIntervalMs;
}

export function normalizeAvatarEmoji(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // Keep this intentionally strict and small for V1.
  return trimmed.slice(0, 8);
}

export async function verifySupabaseAccessToken(
  token: string
): Promise<VerifiedIdentity | null> {
  const supabase = getIdentityClient();
  if (!supabase) return null;

  const normalized = token.trim();
  if (normalized.length === 0) return null;

  const { data, error } = await supabase.auth.getUser(normalized);
  if (error || !data.user?.id) {
    return null;
  }

  return {
    userId: data.user.id,
    email: typeof data.user.email === "string" ? data.user.email : null,
  };
}

export async function getGameHostUserId(
  gameId: string
): Promise<string | null> {
  const supabase = getIdentityClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("game_hosts")
    .select("game_id, host_user_id")
    .eq("game_id", gameId)
    .maybeSingle();

  if (error) {
    console.warn("[Identity] Failed to fetch game host", { gameId, error });
    return null;
  }

  const mapped = mapGameHostRow((data ?? {}) as GameHostRow);
  return mapped?.hostUserId ?? null;
}

export async function ensureGameHostUserId(
  gameId: string,
  userId: string
): Promise<string | null> {
  const supabase = getIdentityClient();
  if (!supabase) return null;

  const existing = await getGameHostUserId(gameId);
  if (existing) return existing;

  const { data, error } = await supabase
    .from("game_hosts")
    .insert({
      game_id: gameId,
      host_user_id: userId,
      updated_at: new Date().toISOString(),
    })
    .select("game_id, host_user_id")
    .maybeSingle();

  if (!error) {
    const mapped = mapGameHostRow((data ?? {}) as GameHostRow);
    if (mapped) return mapped.hostUserId;
  }

  if (!error || !isDuplicateConstraintError(error)) {
    console.warn("[Identity] Failed to set game host", {
      gameId,
      userId,
      error,
    });
    return null;
  }

  return getGameHostUserId(gameId);
}

export async function listSeatClaimsForGame(
  gameId: string
): Promise<SeatClaimRecord[]> {
  const supabase = getIdentityClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("seat_claims")
    .select("game_id, seat_id, owner_user_id, avatar_emoji, disconnected_at")
    .eq("game_id", gameId);

  if (error) {
    console.warn("[Identity] Failed to list seat claims", { gameId, error });
    return [];
  }

  const rows = Array.isArray(data) ? (data as SeatClaimRow[]) : [];
  return rows
    .map((row) => mapSeatClaimRow(row))
    .filter((row): row is SeatClaimRecord => row != null);
}

export async function getSeatClaim(
  gameId: string,
  seatId: string
): Promise<SeatClaimRecord | null> {
  const supabase = getIdentityClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("seat_claims")
    .select("game_id, seat_id, owner_user_id, avatar_emoji, disconnected_at")
    .eq("game_id", gameId)
    .eq("seat_id", seatId)
    .maybeSingle();

  if (error) {
    console.warn("[Identity] Failed to fetch seat claim", {
      gameId,
      seatId,
      error,
    });
    return null;
  }

  return mapSeatClaimRow((data ?? {}) as SeatClaimRow);
}

export async function getUserProfileAvatar(
  userId: string
): Promise<string | null> {
  const supabase = getIdentityClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("user_profiles")
    .select("user_id, avatar_emoji")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.warn("[Identity] Failed to fetch user profile avatar", {
      userId,
      error,
    });
    return null;
  }

  const row = (data ?? {}) as UserProfileRow;
  return typeof row.avatar_emoji === "string" ? row.avatar_emoji : null;
}

export async function upsertUserProfileAvatar(
  userId: string,
  avatarEmoji: string | null
): Promise<string | null> {
  const supabase = getIdentityClient();
  if (!supabase) return null;

  const normalizedAvatar = normalizeAvatarEmoji(avatarEmoji);
  const { error } = await supabase.from("user_profiles").upsert(
    {
      user_id: userId,
      avatar_emoji: normalizedAvatar,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (error) {
    console.warn("[Identity] Failed to upsert user profile avatar", {
      userId,
      error,
    });
    return null;
  }

  return normalizedAvatar;
}

export async function claimSeatOwnership(params: {
  gameId: string;
  seatId: string;
  userId: string;
}): Promise<
  | { ok: true; claim: SeatClaimRecord }
  | { ok: false; reason: "owned-by-other" | "error" }
> {
  const supabase = getIdentityClient();
  if (!supabase) {
    return { ok: false, reason: "error" };
  }

  const { gameId, seatId, userId } = params;
  const profileAvatar = await getUserProfileAvatar(userId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const insertPayload = {
      game_id: gameId,
      seat_id: seatId,
      owner_user_id: userId,
      avatar_emoji: profileAvatar,
      disconnected_at: null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("seat_claims")
      .insert(insertPayload)
      .select("game_id, seat_id, owner_user_id, avatar_emoji, disconnected_at")
      .maybeSingle();

    if (!error) {
      const mapped = mapSeatClaimRow((data ?? {}) as SeatClaimRow);
      if (mapped) return { ok: true, claim: mapped };
    }

    if (!error || !isDuplicateConstraintError(error)) {
      console.warn("[Identity] Failed to insert seat claim", {
        gameId,
        seatId,
        userId,
        error,
      });
      return { ok: false, reason: "error" };
    }

    const existing = await getSeatClaim(gameId, seatId);
    if (!existing) {
      return { ok: false, reason: "error" };
    }

    if (existing.ownerUserId !== userId) {
      if (isClaimExpired(existing.disconnectedAt)) {
        const released = await releaseSeatOwnership({
          gameId,
          seatId,
          requesterUserId: userId,
          ownerUserId: existing.ownerUserId,
          force: true,
        });
        if (released) {
          continue;
        }
      }
      return { ok: false, reason: "owned-by-other" };
    }

    const updatePayload: Record<string, unknown> = {
      disconnected_at: null,
      updated_at: new Date().toISOString(),
    };
    if (profileAvatar !== null) {
      updatePayload.avatar_emoji = profileAvatar;
    }

    const { data: updated, error: updateError } = await supabase
      .from("seat_claims")
      .update(updatePayload)
      .eq("game_id", gameId)
      .eq("seat_id", seatId)
      .eq("owner_user_id", userId)
      .select("game_id, seat_id, owner_user_id, avatar_emoji, disconnected_at")
      .maybeSingle();

    if (updateError) {
      console.warn("[Identity] Failed to refresh existing seat claim", {
        gameId,
        seatId,
        userId,
        updateError,
      });
      return { ok: false, reason: "error" };
    }

    const mapped = mapSeatClaimRow((updated ?? {}) as SeatClaimRow);
    if (!mapped) return { ok: false, reason: "error" };
    return { ok: true, claim: mapped };
  }

  return { ok: false, reason: "owned-by-other" };
}

export async function markSeatClaimDisconnected(params: {
  gameId: string;
  seatId: string;
  userId: string;
}): Promise<SeatClaimRecord | null> {
  const supabase = getIdentityClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("seat_claims")
    .update({
      disconnected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("game_id", params.gameId)
    .eq("seat_id", params.seatId)
    .eq("owner_user_id", params.userId)
    .select("game_id, seat_id, owner_user_id, avatar_emoji, disconnected_at")
    .maybeSingle();

  if (error) {
    console.warn("[Identity] Failed to mark seat claim disconnected", {
      ...params,
      error,
    });
    return null;
  }
  return mapSeatClaimRow((data ?? {}) as SeatClaimRow);
}

export async function clearSeatClaimDisconnected(params: {
  gameId: string;
  seatId: string;
  userId: string;
}): Promise<SeatClaimRecord | null> {
  const supabase = getIdentityClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("seat_claims")
    .update({
      disconnected_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("game_id", params.gameId)
    .eq("seat_id", params.seatId)
    .eq("owner_user_id", params.userId)
    .select("game_id, seat_id, owner_user_id, avatar_emoji, disconnected_at")
    .maybeSingle();

  if (error) {
    console.warn("[Identity] Failed to clear disconnected seat claim", {
      ...params,
      error,
    });
    return null;
  }
  return mapSeatClaimRow((data ?? {}) as SeatClaimRow);
}

export async function setSeatClaimAvatarEmoji(params: {
  gameId: string;
  seatId: string;
  userId: string;
  avatarEmoji: string | null;
}): Promise<SeatClaimRecord | null> {
  const supabase = getIdentityClient();
  if (!supabase) return null;

  const normalizedAvatar = normalizeAvatarEmoji(params.avatarEmoji);

  const { data, error } = await supabase
    .from("seat_claims")
    .update({
      avatar_emoji: normalizedAvatar,
      updated_at: new Date().toISOString(),
    })
    .eq("game_id", params.gameId)
    .eq("seat_id", params.seatId)
    .eq("owner_user_id", params.userId)
    .select("game_id, seat_id, owner_user_id, avatar_emoji, disconnected_at")
    .maybeSingle();

  if (error) {
    console.warn("[Identity] Failed to set seat claim avatar", {
      ...params,
      error,
    });
    return null;
  }

  return mapSeatClaimRow((data ?? {}) as SeatClaimRow);
}

export async function releaseSeatOwnership(params: {
  gameId: string;
  seatId: string;
  requesterUserId: string;
  ownerUserId?: string;
  force?: boolean;
}): Promise<boolean> {
  const supabase = getIdentityClient();
  if (!supabase) return false;

  const existing = await getSeatClaim(params.gameId, params.seatId);
  if (!existing) return true;

  if (!params.force && existing.ownerUserId !== params.requesterUserId) {
    return false;
  }

  const ownerUserIdToDelete = params.force
    ? (params.ownerUserId ?? existing.ownerUserId)
    : params.requesterUserId;

  const { error } = await supabase
    .from("seat_claims")
    .delete()
    .eq("game_id", params.gameId)
    .eq("seat_id", params.seatId)
    .eq("owner_user_id", ownerUserIdToDelete);

  if (error) {
    console.warn("[Identity] Failed to release seat ownership", {
      ...params,
      error,
    });
    return false;
  }
  return true;
}

export async function releaseSeatOwnershipForAiSeat(params: {
  gameId: string;
  seatId: string;
  ownerUserId?: string;
}): Promise<boolean> {
  const supabase = getIdentityClient();
  if (!supabase) return false;
  let query = supabase
    .from("seat_claims")
    .delete()
    .eq("game_id", params.gameId)
    .eq("seat_id", params.seatId);
  if (params.ownerUserId) {
    query = query.eq("owner_user_id", params.ownerUserId);
  }
  const { error } = await query;

  if (error) {
    console.warn("[Identity] Failed to release AI seat ownership", {
      ...params,
      error,
    });
    return false;
  }
  return true;
}

export async function releaseExpiredSeatClaims(): Promise<SeatClaimRecord[]> {
  const supabase = getIdentityClient();
  if (!supabase) return [];

  const cutoffIso = new Date(
    Date.now() - releaseTimeoutSeconds * 1000
  ).toISOString();

  const { data, error } = await supabase
    .from("seat_claims")
    .select("game_id, seat_id, owner_user_id, avatar_emoji, disconnected_at")
    .not("disconnected_at", "is", null)
    .lt("disconnected_at", cutoffIso);

  if (error) {
    console.warn("[Identity] Failed to query expired seat claims", { error });
    return [];
  }

  const rows = Array.isArray(data) ? (data as SeatClaimRow[]) : [];
  const claims = rows
    .map((row) => mapSeatClaimRow(row))
    .filter((row): row is SeatClaimRecord => row != null);

  const released: SeatClaimRecord[] = [];
  for (const claim of claims) {
    const ok = await releaseSeatOwnership({
      gameId: claim.gameId,
      seatId: claim.seatId,
      requesterUserId: claim.ownerUserId,
      ownerUserId: claim.ownerUserId,
      force: true,
    });
    if (ok) {
      released.push(claim);
    }
  }
  return released;
}

export async function releaseAllClaimsForGame(gameId: string): Promise<void> {
  const supabase = getIdentityClient();
  if (!supabase) return;

  const { error: claimError } = await supabase
    .from("seat_claims")
    .delete()
    .eq("game_id", gameId);
  if (claimError) {
    console.warn("[Identity] Failed to clean up seat claims for game", {
      gameId,
      error: claimError,
    });
  }

  const { error: hostError } = await supabase
    .from("game_hosts")
    .delete()
    .eq("game_id", gameId);
  if (hostError) {
    console.warn("[Identity] Failed to clean up game host for game", {
      gameId,
      error: hostError,
    });
  }
}
