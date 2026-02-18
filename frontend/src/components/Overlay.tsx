import { useEffect, useRef } from "react";
import type { DialogHTMLAttributes, MouseEvent, ReactNode } from "react";

type OverlayProps = {
  children: ReactNode;
  translucent?: boolean;
  blurred?: boolean;
  className?: string;
  lockScroll?: boolean;
} & Omit<DialogHTMLAttributes<HTMLDialogElement>, "className">;

export function Overlay({
  children,
  translucent = false,
  blurred = false,
  className,
  lockScroll = true,
  ...rest
}: OverlayProps) {
  const { onClick, ...dialogProps } = rest;
  const overlayFill = translucent ? "bg-black/40" : "bg-black/60";
  const overlayBlur = blurred ? "backdrop-blur-sm" : "";
  const layout = className ?? "items-center justify-center p-4";
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!lockScroll) return;
    const originalOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [lockScroll]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (dialog.open) {
      dialog.close();
    }

    dialog.showModal();

    return () => {
      if (dialog.open) {
        dialog.close();
      }
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    contentRef.current = dialog.firstElementChild as HTMLElement | null;
  }, [children]);

  const handleDialogClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (!onClick) return;
    const content =
      contentRef.current ??
      (dialogRef.current?.firstElementChild as HTMLElement | null);
    if (content) {
      const rect = content.getBoundingClientRect();
      if (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      ) {
        return;
      }
    }
    onClick(event);
  };

  // Use showModal() to put dialog in top layer, AND set view-transition-name: none
  // to explicitly exclude it from View Transition capture. This ensures:
  // 1. Dialog is in top layer (above regular z-index content)
  // 2. Dialog is NOT captured as part of view transition snapshots
  // 3. Dialog remains interactive (real DOM, not frozen snapshot)
  return (
    <dialog
      ref={dialogRef}
      style={{ viewTransitionName: "none" }}
      className={`fixed inset-0 flex transition-all duration-500 overscroll-contain ${layout} ${overlayFill} ${overlayBlur}`}
      onClick={handleDialogClick}
      onCancel={(event) => {
        event.preventDefault();
      }}
      aria-modal="true"
      {...dialogProps}
    >
      {children}
    </dialog>
  );
}
