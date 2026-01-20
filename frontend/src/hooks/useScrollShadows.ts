import { useState, useCallback, useEffect, RefObject, useRef } from "react";

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

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const debouncedCheckScroll = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      checkScroll();
    }, 500);
  }, [checkScroll]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Initial check
    checkScroll();

    // Only respond to actual scroll events - avoid ResizeObserver which causes re-render loops
    // when images load dynamically (as in GameMenu card previews)
    el.addEventListener("scroll", checkScroll, { passive: true });

    // Window resize is needed but debounced to avoid excessive updates
    window.addEventListener("resize", debouncedCheckScroll);

    // Do one delayed check after mount to catch late-loading content
    const delayedCheck = setTimeout(checkScroll, 1000);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      clearTimeout(delayedCheck);
      el.removeEventListener("scroll", checkScroll);
      window.removeEventListener("resize", debouncedCheckScroll);
    };
  }, [ref, checkScroll, debouncedCheckScroll]);

  return shadows;
}
