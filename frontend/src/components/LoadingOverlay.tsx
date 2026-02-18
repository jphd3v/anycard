import { Overlay } from "./Overlay";

interface LoadingOverlayProps {
  message?: string;
}

export function LoadingOverlay({
  message = "Loading game...",
}: LoadingOverlayProps) {
  return (
    <Overlay
      translucent
      blurred
      className="items-center justify-center p-0 lg:p-8 xl:p-12"
    >
      <div
        className="w-full h-full max-w-none rounded-none border-0 bg-surface-1 shadow-floating p-6 flex flex-col items-center justify-center gap-4 lg:h-auto lg:max-w-sm lg:rounded-2xl lg:border lg:border-surface-3"
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
