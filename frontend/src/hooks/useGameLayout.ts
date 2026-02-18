import { useEffect, useState } from "react";
import { SERVER_URL } from "../socket";
import type { GameLayout } from "../../../shared/schemas";

// Cache with TTL to prevent unbounded growth
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_SIZE = 50;

interface CacheEntry {
  layout: GameLayout | null;
  timestamp: number;
}

const layoutCache = new Map<string, CacheEntry>();

function cleanExpiredCache() {
  const now = Date.now();
  for (const [key, entry] of layoutCache) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      layoutCache.delete(key);
    }
  }
  // Also enforce max size by removing oldest entries
  if (layoutCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(layoutCache.entries()).sort(
      (a, b) => a[1].timestamp - b[1].timestamp
    );
    const toRemove = entries.slice(0, layoutCache.size - MAX_CACHE_SIZE);
    for (const [key] of toRemove) {
      layoutCache.delete(key);
    }
  }
}

export function useGameLayout(rulesId: string): GameLayout | null {
  const [layout, setLayout] = useState<GameLayout | null>(null);

  // We only track orientation changes now
  const [isPortrait, setIsPortrait] = useState(
    window.innerHeight > window.innerWidth
  );

  useEffect(() => {
    const handleResize = () => {
      setIsPortrait(window.innerHeight > window.innerWidth);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!rulesId) {
      setLayout(null);
      return;
    }

    // Logic:
    // 1. Landscape layout is required and acts as the default for all orientations.
    // 2. If Portrait -> try `layout-portrait` first, then fallback to `layout-landscape`.
    // 3. If Landscape -> use `layout-landscape`.
    const filenames = isPortrait
      ? [`${rulesId}.layout-portrait.json`, `${rulesId}.layout-landscape.json`]
      : [`${rulesId}.layout-landscape.json`];

    const cacheKey = `${rulesId}:${isPortrait ? "port" : "land"}`;
    const cached = layoutCache.get(cacheKey);
    const now = Date.now();

    // Use cache if entry exists and hasn't expired
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      setLayout(cached.layout);
      return;
    }

    let mounted = true;
    const fetchLayout = async () => {
      // Clean expired entries periodically
      cleanExpiredCache();

      for (const filename of filenames) {
        const res = await fetch(`${SERVER_URL}/rules/${rulesId}/${filename}`);
        if (res.ok) {
          const data = await res.json();
          layoutCache.set(cacheKey, { layout: data, timestamp: Date.now() });
          if (mounted) setLayout(data);
          return;
        }
        // 404 means try next filename, other errors should propagate
        if (res.status !== 404) {
          throw new Error(`Failed to fetch layout: ${res.status}`);
        }
      }
      // No layout found for any filename - cache null result
      layoutCache.set(cacheKey, { layout: null, timestamp: Date.now() });
      if (mounted) setLayout(null);
    };

    fetchLayout();
    return () => {
      mounted = false;
    };
  }, [rulesId, isPortrait]);

  return layout;
}
