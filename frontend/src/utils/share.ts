import { copyToClipboard } from "./clipboard";

/**
 * Share utility function that uses the Web Share API with clipboard fallback
 */

interface ShareData {
  title?: string;
  text?: string;
  url?: string;
}

export interface ShareResult {
  success: boolean;
  type?: "share" | "clipboard";
}

export async function shareData(data: ShareData): Promise<ShareResult> {
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
  const gameUrl = `${window.location.origin}${window.location.pathname}`;
  const title = gameTitle ? `Join ${gameTitle}` : "Join this game";
  const text = `Join my ${gameTitle} game!`;

  return shareData({
    title,
    text,
    url: gameUrl,
  });
}
