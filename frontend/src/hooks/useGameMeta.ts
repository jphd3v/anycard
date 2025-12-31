import { useEffect, useState } from "react";
import { SERVER_URL } from "../socket";

type GameMeta = {
  rulesId: string;
  gameName?: string;
  displayName?: string;
  description?: string;
  minPlayers?: number;
  maxPlayers?: number;
  category?: string;
  requiresJokers?: boolean;
  supportsActions?: boolean;
};

const metaCache = new Map<string, GameMeta | null>();

export function useGameMeta(
  rulesId: string | null | undefined
): GameMeta | null {
  const [meta, setMeta] = useState<GameMeta | null>(null);

  useEffect(() => {
    if (!rulesId) {
      setMeta(null);
      return;
    }

    const cached = metaCache.get(rulesId);
    if (cached !== undefined) {
      setMeta(cached);
      return;
    }

    let mounted = true;
    const fetchMeta = async () => {
      try {
        const res = await fetch(`${SERVER_URL}/rules/${rulesId}/meta.json`);
        if (!res.ok) {
          metaCache.set(rulesId, null);
          if (mounted) setMeta(null);
          return;
        }
        const data = (await res.json()) as GameMeta;
        metaCache.set(rulesId, data);
        if (mounted) setMeta(data);
      } catch {
        metaCache.set(rulesId, null);
        if (mounted) setMeta(null);
      }
    };

    fetchMeta();
    return () => {
      mounted = false;
    };
  }, [rulesId]);

  return meta;
}
