import { copyToClipboard } from "./clipboard";

/**
 * Share utility function that uses the Web Share API with clipboard fallback
 */

const supabaseEmailRedirectTo =
  import.meta.env.VITE_SUPABASE_EMAIL_REDIRECT_TO?.trim();

interface ShareData {
  title?: string;
  text?: string;
  url?: string;
}

export interface ShareResult {
  success: boolean;
  type?: "share" | "clipboard";
}

async function shareData(data: ShareData): Promise<ShareResult> {
  // Check if the Web Share API is supported
  if (navigator.share) {
    try {
      await navigator.share(data);
      return { success: true, type: "share" };
    } catch (error) {
      // If the user cancels the share dialog, that's fine
      if (error instanceof Error && error.name === "AbortError") {
        return { success: false };
      }

      // Some browsers (especially on mobile) can be picky about multiple fields.
      // Try again with just text and url if we had a title.
      if (data.title && (data.text || data.url)) {
        try {
          await navigator.share({
            text: data.text,
            url: data.url,
          });
          return { success: true, type: "share" };
        } catch {
          // Still failed, will fall back to clipboard
        }
      }

      // Otherwise log the error and fall back to clipboard
      console.warn("Web Share API failed, trying clipboard:", error);
    }
  } else if (!window.isSecureContext) {
    console.warn(
      "Web Share API is not available. This is likely because the page is not being served from a secure context (HTTPS or localhost)."
    );
  }

  // Fallback to clipboard
  // User requested to only copy the URL for clipboard fallback
  const content =
    data.url || [data.title, data.text].filter(Boolean).join("\n").trim();

  const success = await copyToClipboard(content);
  return { success, type: success ? "clipboard" : undefined };
}

// Convenience function to share game information
export async function shareGameInfo(gameTitle?: string): Promise<ShareResult> {
  const gameUrl = resolveGameShareUrl();
  const title = gameTitle ? `Join ${gameTitle}` : "Join this game";
  const text = gameTitle ? `Join my ${gameTitle} game!` : "Join my game!";

  return shareData({
    title,
    text,
    url: gameUrl,
  });
}

function resolveGameShareUrl(): string {
  const path = `${window.location.pathname}${window.location.search}`;

  if (supabaseEmailRedirectTo) {
    try {
      return new URL(path, supabaseEmailRedirectTo).toString();
    } catch {
      // Fall through to dynamic origin handling.
    }
  }

  const candidate = `${window.location.origin}${path}`;
  try {
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.toLowerCase();
    const isLocalhostLike =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1";

    // In mobile/web production builds, Capacitor origin is often https://localhost.
    // Avoid sharing localhost links and fall back to configured public URL root.
    if (!import.meta.env.DEV && isLocalhostLike && supabaseEmailRedirectTo) {
      return new URL(path, supabaseEmailRedirectTo).toString();
    }

    return parsed.toString();
  } catch {
    return candidate;
  }
}
