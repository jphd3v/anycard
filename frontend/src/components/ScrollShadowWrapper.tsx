import React, { useRef } from "react";
import { useScrollShadows } from "../hooks/useScrollShadows";

interface Props {
  children: React.ReactNode;
  className?: string; // Classes for the outer container
  innerClassName?: string; // Classes for the scrollable element
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  id?: string;
  scrollRef?: React.RefObject<HTMLDivElement>;
}

/**
 * A wrapper that uses CSS masking to gradually fade/darken content
 * at the edges when scrolling is available.
 */
export function ScrollShadowWrapper({
  children,
  className = "",
  innerClassName = "",
  onScroll,
  id,
  scrollRef: providedScrollRef,
}: Props) {
  const internalScrollRef = useRef<HTMLDivElement>(null);
  const scrollRef = providedScrollRef ?? internalScrollRef;
  const shadows = useScrollShadows(scrollRef);

  // We use CSS mask-image to create a subtle fade effect.
  // When a side is scrollable, the mask goes from transparent to black.
  // We combine a vertical and horizontal mask using mask-composite.
  const maskImage = `
    linear-gradient(to bottom, 
      ${shadows.top ? "transparent" : "black"} 0%, 
      black 20px, 
      black calc(100% - 20px), 
      ${shadows.bottom ? "transparent" : "black"} 100%
    ),
    linear-gradient(to right, 
      ${shadows.left ? "transparent" : "black"} 0%, 
      black 20px, 
      black calc(100% - 20px), 
      ${shadows.right ? "transparent" : "black"} 100%
    )
  `;

  return (
    <div className={`relative overflow-hidden flex flex-col ${className}`}>
      <div
        id={id}
        ref={scrollRef}
        onScroll={onScroll}
        className={`flex-1 overflow-auto ${innerClassName}`}
        style={{
          maskImage,
          WebkitMaskImage: maskImage,
          maskComposite: "intersect",
          WebkitMaskComposite: "source-in",
          transition: "mask-image 0.3s ease, -webkit-mask-image 0.3s ease",
        }}
      >
        {children}
      </div>
    </div>
  );
}
