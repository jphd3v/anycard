import { useEffect } from "react";
import type { HTMLAttributes, ReactNode } from "react";

type OverlayProps = {
  children: ReactNode;
  translucent?: boolean;
  blurred?: boolean;
  className?: string;
  lockScroll?: boolean;
} & Omit<HTMLAttributes<HTMLDivElement>, "className">;

export function Overlay({
  children,
  translucent = false,
  blurred = false,
  className,
  lockScroll = true,
  ...rest
}: OverlayProps) {
  const overlayFill = translucent ? "bg-black/40" : "bg-black/60";
  const overlayBlur = blurred ? "backdrop-blur-sm" : "";
  const layout = className ?? "items-center justify-center p-4";

  useEffect(() => {
    if (!lockScroll) return;
    const originalOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [lockScroll]);

  return (
    <div
      className={`fixed inset-0 z-[1000] flex transition-all duration-500 overscroll-contain ${layout} ${overlayFill} ${overlayBlur}`}
      {...rest}
    >
      {children}
    </div>
  );
}
