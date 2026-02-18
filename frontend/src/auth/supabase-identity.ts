import {
  createClient,
  type EmailOtpType,
  type Session,
  type SupabaseClient,
} from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabasePublicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
const supabaseEmailRedirectTo =
  import.meta.env.VITE_SUPABASE_EMAIL_REDIRECT_TO?.trim();
const GUEST_ID_STORAGE_KEY = "guest-id";
const SIGN_IN_CONFIGURATION_ERROR_MESSAGE =
  "Sign-in is temporarily unavailable. Please try again later.";

export type ClientIdentityState = {
  mode: "guest" | "user";
  guestId: string;
  userId: string | null;
  email: string | null;
};

let supabaseClient: SupabaseClient | null = null;
let pendingAccessToken: Promise<string | null> | null = null;
let tokenRefreshInitialized = false;

function randomId(len: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let output = "";
  for (let i = 0; i < len; i += 1) {
    output += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return output;
}

function ensureGuestId(): string {
  if (typeof window === "undefined") {
    return `guest_${randomId(12)}`;
  }

  const existing = window.localStorage.getItem(GUEST_ID_STORAGE_KEY);
  if (existing && existing.trim().length >= 8) {
    return existing;
  }

  const guestId =
    typeof window.crypto?.randomUUID === "function"
      ? `guest_${window.crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
      : `guest_${randomId(24)}`;
  window.localStorage.setItem(GUEST_ID_STORAGE_KEY, guestId);
  return guestId;
}

function getSupabaseClient(): SupabaseClient | null {
  if (!supabaseUrl || !supabasePublicKey) {
    return null;
  }

  if (supabaseClient) {
    return supabaseClient;
  }

  supabaseClient = createClient(supabaseUrl, supabasePublicKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  });

  return supabaseClient;
}

function identityFromSession(session: Session | null): ClientIdentityState {
  const guestId = ensureGuestId();
  const userId = session?.user?.id ?? null;
  const email =
    typeof session?.user?.email === "string" ? session.user.email : null;
  return {
    mode: userId ? "user" : "guest",
    guestId,
    userId,
    email,
  };
}

export function getGuestId(): string {
  return ensureGuestId();
}

export function isSupabaseIdentityEnabledOnClient(): boolean {
  return getSupabaseClient() != null;
}

export async function resolveSupabaseAccessToken(): Promise<string | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  if (pendingAccessToken) {
    return pendingAccessToken;
  }

  pendingAccessToken = client.auth
    .getSession()
    .then(({ data, error }) => {
      if (error) {
        console.warn("[Identity] Failed to read Supabase session", error);
        return null;
      }
      return data.session?.access_token ?? null;
    })
    .finally(() => {
      pendingAccessToken = null;
    });

  return pendingAccessToken;
}

export async function resolveClientIdentity(): Promise<ClientIdentityState> {
  const client = getSupabaseClient();
  if (!client) {
    return {
      mode: "guest",
      guestId: ensureGuestId(),
      userId: null,
      email: null,
    };
  }
  const { data, error } = await client.auth.getSession();
  if (error) {
    console.warn("[Identity] Failed to resolve client identity", error);
    return {
      mode: "guest",
      guestId: ensureGuestId(),
      userId: null,
      email: null,
    };
  }
  return identityFromSession(data.session ?? null);
}

export async function signInWithEmailMagicLink(email: string): Promise<void> {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase client not configured");
  }

  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Email is required");
  }

  const redirectTo = resolveEmailMagicLinkRedirectTo();
  if (!redirectTo && !import.meta.env.DEV) {
    throw new Error(SIGN_IN_CONFIGURATION_ERROR_MESSAGE);
  }

  const { error } = await client.auth.signInWithOtp({
    email: normalized,
    options: redirectTo ? { emailRedirectTo: redirectTo } : undefined,
  });
  if (error) {
    throw error;
  }
}

export async function consumeSupabaseAuthCallbackFromUrl(
  rawUrl: string
): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  let consumed = false;

  const tokenHash = parsed.searchParams.get("token_hash");
  const tokenType = resolveEmailOtpType(parsed.searchParams.get("type"));
  if (tokenHash && tokenType) {
    const { error } = await client.auth.verifyOtp({
      token_hash: tokenHash,
      type: tokenType,
    });
    if (error) {
      console.warn(
        "[Identity] Failed to verify token hash from deep link",
        error
      );
    } else {
      consumed = true;
    }
  }

  const code = parsed.searchParams.get("code");
  if (code) {
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (error) {
      console.warn("[Identity] Failed to exchange auth code", error);
    } else {
      consumed = true;
    }
  }

  const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const accessToken = hashParams.get("access_token");
  const refreshToken = hashParams.get("refresh_token");
  if (accessToken && refreshToken) {
    const { error } = await client.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) {
      console.warn("[Identity] Failed to set session from deep link", error);
    } else {
      consumed = true;
    }
  }

  return consumed;
}

function resolveEmailOtpType(type: string | null): EmailOtpType | null {
  const normalized = type?.trim() ?? "";
  if (isSupportedEmailOtpType(normalized)) {
    return normalized;
  }

  return null;
}

function isSupportedEmailOtpType(type: string): type is EmailOtpType {
  return (
    type === "signup" ||
    type === "invite" ||
    type === "magiclink" ||
    type === "recovery" ||
    type === "email_change" ||
    type === "email"
  );
}

function resolveEmailMagicLinkRedirectTo(): string | undefined {
  if (supabaseEmailRedirectTo) {
    let parsedConfiguredRedirect: URL;
    try {
      parsedConfiguredRedirect = new URL(supabaseEmailRedirectTo);
    } catch {
      throw new Error(SIGN_IN_CONFIGURATION_ERROR_MESSAGE);
    }

    if (
      !import.meta.env.DEV &&
      isLocalhostLikeHostname(parsedConfiguredRedirect.hostname)
    ) {
      throw new Error(SIGN_IN_CONFIGURATION_ERROR_MESSAGE);
    }

    return parsedConfiguredRedirect.toString();
  }
  if (typeof window === "undefined") {
    return undefined;
  }

  const candidate = `${window.location.origin}${window.location.pathname}${window.location.search}`;
  try {
    const parsed = new URL(candidate);
    const isLocalhostLike = isLocalhostLikeHostname(parsed.hostname);

    // In mobile/web production builds, Capacitor origin is often https://localhost.
    // Fail fast to avoid sending incorrect localhost links in emails.
    if (!import.meta.env.DEV && isLocalhostLike) {
      throw new Error(SIGN_IN_CONFIGURATION_ERROR_MESSAGE);
    }

    return parsed.toString();
  } catch {
    return undefined;
  }
}

function isLocalhostLikeHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return (
    normalizedHostname === "localhost" ||
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "::1"
  );
}

export async function signOutSupabaseIdentity(): Promise<void> {
  const client = getSupabaseClient();
  if (!client) return;
  const { error } = await client.auth.signOut();
  if (error) {
    throw error;
  }
}

export function initSupabaseTokenRefresh(
  onTokenRefresh: (token: string | null) => void
): void {
  const client = getSupabaseClient();
  if (!client || tokenRefreshInitialized) {
    return;
  }

  tokenRefreshInitialized = true;
  client.auth.onAuthStateChange((_event, session) => {
    onTokenRefresh(session?.access_token ?? null);
  });
}

export function subscribeClientIdentity(
  listener: (identity: ClientIdentityState) => void
): () => void {
  const client = getSupabaseClient();
  if (!client) {
    listener({
      mode: "guest",
      guestId: ensureGuestId(),
      userId: null,
      email: null,
    });
    return () => {};
  }

  void client.auth
    .getSession()
    .then(({ data }) => {
      listener(identityFromSession(data.session ?? null));
    })
    .catch((error) => {
      console.warn("[Identity] Failed to load initial identity", error);
      listener({
        mode: "guest",
        guestId: ensureGuestId(),
        userId: null,
        email: null,
      });
    });

  const { data } = client.auth.onAuthStateChange((_event, session) => {
    listener(identityFromSession(session));
  });
  return () => {
    data.subscription.unsubscribe();
  };
}
