import { useEffect, useState, type ReactNode } from "react";
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
  forceMinimized?: boolean;
  disableRestore?: boolean;
  minimizedContent?: ReactNode;
  onClose?: () => void;
  position?: "center" | "bottom";
  viewTransitionName?: string;
  overlayClassName?: string;
  showBackArrow?: boolean;
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
  forceMinimized = false,
  disableRestore = false,
  minimizedContent,
  onClose,
  position = "center",
  viewTransitionName,
  overlayClassName = "",
  showBackArrow = false,
}: Props) {
  const [isMinimized, setIsMinimized] = useState(false);
  useEffect(() => {
    if (forceMinimized) {
      setIsMinimized(true);
    }
  }, [forceMinimized]);

  const panelFill = translucent ? "bg-surface-2/80" : "bg-surface-2";
  const panelBorder =
    tone === "error" ? "border-red-500/30" : "border-surface-3";
  const titleColor = tone === "error" ? "text-red-600" : "text-ink";
  const descriptionMarginClass = descriptionClassName ? "" : "mb-8 sm:mb-2";

  const containerClasses = `
    w-full max-w-md landscape:max-w-4xl p-6 sm:p-8 rounded-2xl shadow-floating text-center border transition-all relative
    ${panelFill} ${panelBorder} ${panelClassName}
  `;
  const headingSizeClass = titleClassName ? "" : "text-xl sm:text-2xl";
  const headingClasses = `${headingSizeClass} font-bold mb-4 ${titleColor} ${titleClassName}`;
  const descriptionClasses = `
    text-ink-muted text-base leading-relaxed
    ${descriptionMarginClass} ${descriptionClassName}
  `;

  const overlayLayout = isMinimized
    ? "items-end justify-center pb-8 pointer-events-none"
    : position === "bottom"
      ? "items-end justify-center pb-4 px-4 sm:px-6"
      : "items-center justify-center p-4 overflow-y-auto";
  const overlayClasses = `${overlayLayout} ${overlayClassName}`.trim();
  const overlayStyle = viewTransitionName ? { viewTransitionName } : undefined;

  return (
    <Overlay
      translucent={translucent}
      blurred={blurredOverlay}
      data-testid="fullscreen-message"
      className={overlayClasses}
      lockScroll={!isMinimized}
      style={overlayStyle}
    >
      {isMinimized ? (
        minimizedContent ? (
          minimizedContent
        ) : (
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
        )
      ) : (
        <div
          className={`${containerClasses} flex flex-col h-fit max-h-none landscape:mb-8`}
        >
          {onClose && (
            <button
              onClick={onClose}
              className={`absolute top-2 ${showBackArrow ? "left-2 sm:left-4" : "right-2 sm:right-4"} sm:top-4 p-2 text-ink-muted hover:text-ink hover:bg-surface-2 rounded-full transition-colors z-30`}
              aria-label={showBackArrow ? "Back" : "Close"}
            >
              {showBackArrow ? (
                <svg
                  className="w-6 h-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10 19l-7-7m0 0l7-7m-7 7h18"
                  />
                </svg>
              ) : (
                <svg
                  className="w-6 h-6"
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
              )}
            </button>
          )}
          {canMinimize && !disableRestore && (
            <button
              onClick={() => setIsMinimized(true)}
              className="absolute top-2 right-2 sm:top-4 sm:right-4 p-2 text-ink-muted hover:text-ink hover:bg-surface-3 rounded-full transition-colors z-30"
              title="Minimize"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                className="w-6 h-6"
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
