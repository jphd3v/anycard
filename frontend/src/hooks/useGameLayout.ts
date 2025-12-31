import { useEffect, useState } from "react";
import { SERVER_URL } from "../socket";
import type { GameLayout } from "../../../shared/schemas";

const layoutCache = new Map<string, GameLayout | null>();

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
    // 1. If Portrait -> Try `portrait` layout first.
    // 2. If Landscape (Mobile OR Desktop) -> Try `wide` layout first.
    //    We trust CSS to scale the 10-column wide layout down to mobile size.
    // 3. Fallback -> `layout.json`

    const filenames = isPortrait
      ? [`${rulesId}.layout-portrait.json`, `${rulesId}.layout.json`]
      : [`${rulesId}.layout-wide.json`, `${rulesId}.layout.json`];

    const cacheKey = `${rulesId}:${isPortrait ? "port" : "land"}`;
    const cached = layoutCache.get(cacheKey);
    if (cached !== undefined) {
      setLayout(cached);
      return;
    }

    let mounted = true;
    const fetchLayout = async () => {
      for (const filename of filenames) {
        try {
          const res = await fetch(`${SERVER_URL}/rules/${rulesId}/${filename}`);
          if (res.ok) {
            const data = await res.json();
            layoutCache.set(cacheKey, data);
            if (mounted) setLayout(data);
            return;
          }
        } catch {
          /* continue */
        }
      }
      if (mounted) setLayout(null);
    };

    fetchLayout();
    return () => {
      mounted = false;
    };
  }, [rulesId, isPortrait]);

  return layout;
}
