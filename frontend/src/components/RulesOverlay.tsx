import { useEffect, useState } from "react";
import { SERVER_URL } from "../socket";
import { Overlay } from "./Overlay";
import { useGameMeta } from "../hooks/useGameMeta";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ScrollShadowWrapper } from "./ScrollShadowWrapper";

interface Props {
  rulesId: string;
  onClose: () => void;
}

export function RulesOverlay({ rulesId, onClose }: Props) {
  const [rulesText, setRulesText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const meta = useGameMeta(rulesId);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    setLoading(true);
    fetch(`${SERVER_URL}/rules/${rulesId}/${rulesId}.rules.md`)
      .then((res) => {
        if (!res.ok) throw new Error("No rules found");
        return res.text();
      })
      .then((text) => setRulesText(text))
      .catch(() => setRulesText("Rules not available for this game."))
      .finally(() => setLoading(false));
  }, [rulesId]);

  const playerLabel =
    meta?.minPlayers === meta?.maxPlayers
      ? `${meta?.minPlayers} Players`
      : `${meta?.minPlayers}-${meta?.maxPlayers} Players`;

  return (
    <Overlay
      translucent
      blurred
      className="items-center justify-center p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-lg bg-surface-1 rounded-2xl shadow-floating flex flex-col max-h-[85vh] overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
        aria-label="Game Rules"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sticky Header: Name + Meta on one line */}
        <div className="px-6 py-4 border-b border-surface-2 flex items-center justify-between bg-surface-1/95 backdrop-blur-md sticky top-0 z-20 gap-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 overflow-hidden">
            <div className="uppercase font-serif-display font-bold text-ink whitespace-nowrap">
              {meta?.gameName ?? "Game Rules"}
            </div>

            {meta && (
              <div className="flex items-center gap-2 text-xs font-bold text-ink-muted uppercase tracking-wider opacity-80">
                {meta.category && (
                  <span className="bg-surface-3/50 px-2 py-0.5 rounded whitespace-nowrap">
                    {meta.category}
                  </span>
                )}
                <span className="whitespace-nowrap hidden sm:inline-block">
                  • {playerLabel}
                </span>
              </div>
            )}
          </div>

          <button
            onClick={onClose}
            className="p-2 -mr-2 text-ink-muted hover:text-ink hover:bg-surface-2 rounded-full transition-colors flex-shrink-0"
            aria-label="Close"
          >
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
          </button>
        </div>

        {/* Scrollable Content */}
        <ScrollShadowWrapper className="flex-1" innerClassName="scrollbar-hide">
          <div className="p-6 w-fit min-w-full">
            {loading ? (
              <div className="py-8 flex justify-center">
                <div className="spinner h-6 w-6 border-2" />
              </div>
            ) : (
              rulesText && <MarkdownRenderer content={rulesText} />
            )}
          </div>
        </ScrollShadowWrapper>

        {/* Footer */}
        <div className="p-4 border-t border-surface-2 bg-surface-1/50 flex justify-end">
          <button
            onClick={onClose}
            className="button-base button-secondary px-4 py-2 text-sm"
          >
            Close
          </button>
        </div>
      </div>
    </Overlay>
  );
}
