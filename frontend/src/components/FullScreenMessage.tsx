import { useState, type ReactNode } from "react";
import { Overlay } from "./Overlay";

interface Props {
  title: string;
  description: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "error";
  translucent?: boolean;
  blurredOverlay?: boolean;
  panelClassName?: string;
  descriptionClassName?: string;
  titleClassName?: string;
  canMinimize?: boolean;
  blockInteractionsWhenMinimized?: boolean;
  onClose?: () => void;
}

export function FullScreenMessage({
  title,
  description,
  action,
  tone = "neutral",
  translucent = false,
  blurredOverlay = false,
  panelClassName = "",
  descriptionClassName = "",
  titleClassName = "",
  canMinimize = false,
  blockInteractionsWhenMinimized = false,
  onClose,
}: Props) {
  const [isMinimized, setIsMinimized] = useState(false);

  const panelFill = translucent ? "bg-surface-2/80" : "bg-surface-2";
  const panelBorder =
    tone === "error" ? "border-red-500/30" : "border-surface-3";
  const titleColor = tone === "error" ? "text-red-600" : "text-ink";
  const descriptionMarginClass = descriptionClassName ? "" : "mb-8 sm:mb-2";

  const containerClasses = `
    w-full max-w-md p-6 sm:p-8 rounded-2xl shadow-floating text-center border transition-all relative
    ${panelFill} ${panelBorder} ${panelClassName}
  `;
  const headingSizeClass = titleClassName ? "" : "text-xl sm:text-2xl";
  const headingClasses = `${headingSizeClass} font-bold mb-4 ${titleColor} ${titleClassName}`;
  const descriptionClasses = `
    text-ink-muted text-base leading-relaxed
    ${descriptionMarginClass} ${descriptionClassName}
  `;

  return (
    <Overlay
      translucent={translucent}
      blurred={blurredOverlay}
      data-testid="fullscreen-message"
      className={
        isMinimized
          ? `items-end justify-center pb-8 ${
              blockInteractionsWhenMinimized ? "" : "pointer-events-none"
            }`
          : "items-center justify-center p-4"
      }
      lockScroll={!isMinimized || blockInteractionsWhenMinimized}
    >
      {isMinimized ? (
        <button
          onClick={() => setIsMinimized(false)}
          className={`pointer-events-auto px-4 py-2 rounded-full shadow-floating border flex items-center gap-2 transition-all hover:scale-105 active:scale-95 ${panelFill} ${panelBorder}`}
        >
          <span className={`text-xs font-bold ${titleColor}`}>{title}</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2.5}
            stroke="currentColor"
            className="w-4 h-4"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4.5 15.75l7.5-7.5 7.5 7.5"
            />
          </svg>
        </button>
      ) : (
        <div className={`${containerClasses} flex flex-col overflow-hidden`}>
          {onClose && (
            <button
              onClick={onClose}
              className="absolute top-4 right-4 p-2 -mr-2 -mt-2 text-ink-muted hover:text-ink hover:bg-surface-3 rounded-full transition-colors z-30"
              aria-label="Close"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
          {canMinimize && (
            <button
              onClick={() => setIsMinimized(true)}
              className="absolute top-4 right-4 text-ink-muted hover:text-ink transition-colors"
              title="Minimize"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2.5}
                stroke="currentColor"
                className="w-5 h-5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                />
              </svg>
            </button>
          )}
          <h1 className={headingClasses}>{title}</h1>
          <div className={descriptionClasses}>{description}</div>
          {action && <div className="flex justify-center">{action}</div>}
        </div>
      )}
    </Overlay>
  );
}
