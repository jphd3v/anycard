import { useEffect, useState } from "react";
import { DEFAULT_CARD_BACK, DEFAULT_CARD_SET } from "../cardSets";

const DEFAULT_ASPECT_RATIO = 5 / 7;
const MIN_ASPECT_RATIO = 0.45;
const MAX_ASPECT_RATIO = 0.9;

const aspectCache = new Map<string, number>();

function parseSvgAspectRatio(svgText: string): number | null {
  try {
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const root = doc.documentElement;

    const viewBox = root.getAttribute("viewBox");
    if (viewBox) {
      const parts = viewBox
        .trim()
        .split(/[,\s]+/)
        .map((v) => Number(v));
      if (parts.length === 4) {
        const width = parts[2];
        const height = parts[3];
        if (Number.isFinite(width) && Number.isFinite(height) && height > 0) {
          return width / height;
        }
      }
    }

    const widthAttr = root.getAttribute("width");
    const heightAttr = root.getAttribute("height");
    if (widthAttr && heightAttr) {
      const width = Number.parseFloat(widthAttr);
      const height = Number.parseFloat(heightAttr);
      if (Number.isFinite(width) && Number.isFinite(height) && height > 0) {
        return width / height;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export function useCardSetAspectRatio(
  cardSetId: string | null | undefined
): number {
  const effectiveId = cardSetId ?? DEFAULT_CARD_SET;
  const [aspect, setAspect] = useState<number>(
    () => aspectCache.get(effectiveId) ?? DEFAULT_ASPECT_RATIO
  );

  useEffect(() => {
    const cached = aspectCache.get(effectiveId);
    if (cached) {
      setAspect(cached);
      return;
    }

    let mounted = true;
    const run = async () => {
      try {
        const res = await fetch(
          `/cards/${effectiveId}/${DEFAULT_CARD_BACK}.svg`
        );
        if (!res.ok) return;
        const svg = await res.text();
        const ratio = parseSvgAspectRatio(svg);
        if (!ratio) return;
        if (!Number.isFinite(ratio) || ratio <= 0) return;
        const clamped = Math.min(
          MAX_ASPECT_RATIO,
          Math.max(MIN_ASPECT_RATIO, ratio)
        );

        aspectCache.set(effectiveId, clamped);
        if (mounted) setAspect(clamped);
      } catch {
        // ignore
      }
    };

    run();
    return () => {
      mounted = false;
    };
  }, [effectiveId]);

  return aspect;
}
