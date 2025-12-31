import { Overlay } from "./Overlay";

interface ConfirmationOverlayProps {
  title: string;
  description?: string;
  confirmLabel: string;
  confirmTone?: "danger" | "warning" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}

export function ConfirmationOverlay({
  title,
  description,
  confirmLabel,
  confirmTone = "danger",
  onConfirm,
  onCancel,
  children,
}: ConfirmationOverlayProps) {
  const buttonToneClass =
    confirmTone === "danger"
      ? "button-danger"
      : confirmTone === "warning"
        ? "button-secondary text-amber-600 hover:text-amber-700"
        : "button-primary";

  return (
    <Overlay
      translucent
      blurred
      className="items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-surface-3 bg-surface-1 shadow-floating p-5 sm:p-6 flex flex-col gap-4 items-center text-center"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="text-base font-semibold text-ink">{title}</div>
        {description && (
          <div className="text-sm text-ink-muted">{description}</div>
        )}
        {children}
        <div className="flex justify-center gap-2 pt-2 w-full">
          <button
            type="button"
            className="button-base button-secondary px-4 py-2 text-sm"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`button-base ${buttonToneClass} px-4 py-2 text-sm`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
