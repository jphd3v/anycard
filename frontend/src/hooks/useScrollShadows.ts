import { useState, useEffect, RefObject, useRef } from "react";

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

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Define handlers inside effect to ensure stable references for cleanup
    const checkScroll = () => {
      const element = ref.current;
      if (!element) return;

      // Use a small buffer (1px) to avoid flickering due to sub-pixel rendering
      const top = element.scrollTop > 1;
      const bottom =
        element.scrollTop + element.clientHeight < element.scrollHeight - 1;
      const left = element.scrollLeft > 1;
      const right =
        element.scrollLeft + element.clientWidth < element.scrollWidth - 1;

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
    };

    const debouncedCheckScroll = () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(checkScroll, 500);
    };

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
  }, [ref]);

  return shadows;
}
