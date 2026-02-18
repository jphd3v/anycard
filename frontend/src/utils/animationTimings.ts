const DEFAULT_CARD_FLIP_MS = 320;

export function getDynamicDuration(
  queueLength: number,
  isMyTurn: boolean
): number {
  // If we are live (no backlog), always animate fully so the user sees what happened,
  // even if it becomes their turn.
  if (queueLength === 0) return 1000;

  // If we are catching up from a backlog:
  if (isMyTurn) return 0; // Snap immediately if we are behind and it becomes my turn
  if (queueLength > 2) return 200; // Very fast catch-up
  return 500; // Brisk pace
}

export function parseDurationMs(value: string, fallback: number): number {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (trimmed.endsWith("ms")) {
    const ms = Number.parseFloat(trimmed.slice(0, -2));
    return Number.isFinite(ms) ? ms : fallback;
  }
  if (trimmed.endsWith("s")) {
    const sec = Number.parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(sec) ? sec * 1000 : fallback;
  }
  const raw = Number.parseFloat(trimmed);
  return Number.isFinite(raw) ? raw : fallback;
}

export function getCardFlipDurationMs(): number {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return DEFAULT_CARD_FLIP_MS;
  }
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return 0;
  }
  const cssValue = getComputedStyle(document.documentElement).getPropertyValue(
    "--card-flip-duration"
  );
  return parseDurationMs(cssValue, DEFAULT_CARD_FLIP_MS);
}
