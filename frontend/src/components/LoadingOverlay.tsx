import { Overlay } from "./Overlay";

interface LoadingOverlayProps {
  message?: string;
}

export function LoadingOverlay({
  message = "Loading game...",
}: LoadingOverlayProps) {
  return (
    <Overlay translucent blurred className="items-center justify-center p-4">
      <div
        className="w-full max-w-sm rounded-2xl border border-surface-3 bg-surface-1 shadow-floating p-6 flex flex-col items-center justify-center gap-4"
        role="dialog"
        aria-modal="true"
        aria-label="Loading game"
      >
        <div className="flex flex-col items-center justify-center gap-3">
          {/* Spinner */}
          <div className="relative w-12 h-12">
            <div className="absolute inset-0 rounded-full border-4 border-surface-3 border-t-primary animate-spin"></div>
          </div>

          {/* Message */}
          <div className="text-center">
            <p className="text-ink font-medium">{message}</p>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
