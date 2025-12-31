import { useState, useCallback, useEffect, RefObject } from "react";

export interface ScrollShadows {
  top: boolean;
  bottom: boolean;
  left: boolean;
  right: boolean;
}

export function useScrollShadows(ref: RefObject<HTMLElement | null>) {
  const [shadows, setShadows] = useState<ScrollShadows>({
    top: false,
    bottom: false,
    left: false,
    right: false,
  });

  const checkScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    // Use a small buffer (1px) to avoid flickering due to sub-pixel rendering
    const top = el.scrollTop > 1;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;

    setShadows((prev) => {
      if (
        prev.top === top &&
        prev.bottom === bottom &&
        prev.left === left &&
        prev.right === right
      ) {
        return prev;
      }
      return { top, bottom, left, right };
    });
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    checkScroll();

    // Use ResizeObserver to detect content changes as well
    const resizeObserver = new ResizeObserver(checkScroll);
    resizeObserver.observe(el);
    // If there's an inner wrapper, observe that too for content changes
    if (el.firstElementChild) {
      resizeObserver.observe(el.firstElementChild as HTMLElement);
    }

    el.addEventListener("scroll", checkScroll, { passive: true });
    window.addEventListener("resize", checkScroll);

    return () => {
      resizeObserver.disconnect();
      el.removeEventListener("scroll", checkScroll);
      window.removeEventListener("resize", checkScroll);
    };
  }, [ref, checkScroll]);

  return shadows;
}
