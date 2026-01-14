import { useEffect, useCallback } from "react";
import { Overlay } from "./Overlay";
import { copyToClipboard } from "../utils/clipboard";
import { ScrollShadowWrapper } from "./ScrollShadowWrapper";

interface Props {
  onClose: () => void;
}

export function AboutOverlay({ onClose }: Props) {
  const commitHash =
    typeof __COMMIT_HASH__ !== "undefined" ? __COMMIT_HASH__ : "dev";
  const commitDate =
    typeof __COMMIT_DATE__ !== "undefined" ? __COMMIT_DATE__ : "";

  const handleCopyVersion = useCallback(async () => {
    const text = `version #${commitHash} ${commitDate}`;
    await copyToClipboard(text);
  }, [commitHash, commitDate]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <Overlay
      translucent
      blurred
      className="items-center justify-center p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        className="about-modal relative w-full max-w-lg bg-surface-1 rounded-2xl shadow-floating flex flex-col max-h-[85vh] overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
        aria-label="About AnyCard"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-surface-2 flex items-center justify-between gap-4">
          <div className="about-modal-title uppercase font-serif-display font-bold text-ink whitespace-nowrap">
            About AnyCard
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

        {/* Content */}
        <ScrollShadowWrapper
          className="flex-1 min-h-0"
          innerClassName="about-modal-body p-6 scrollbar-hide space-y-6 text-sm text-ink"
        >
          <section>
            <p className="leading-relaxed">
              AnyCard is a card game engine designed for implementing and
              playing almost any card game.
            </p>
            <p className="mt-2 text-xs text-ink-muted">
              Copyright &copy; 2025 JPH.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="font-bold uppercase tracking-wider text-xs text-ink-muted">
              License
            </h3>
            <p className="leading-relaxed">
              This software is licensed under the{" "}
              <a
                href="https://github.com/jphd3v/anycard/blob/main/LICENSE.txt"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline font-bold"
              >
                GNU Affero General Public License v3.0 (AGPL-3.0)
              </a>
              . The source code is available on{" "}
              <a
                href="https://github.com/jphd3v/anycard"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                GitHub
              </a>
              .
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="font-bold uppercase tracking-wider text-xs text-ink-muted">
              No Warranty
            </h3>
            <p className="leading-relaxed text-[11px] opacity-80 uppercase font-mono">
              THERE IS NO WARRANTY FOR THE PROGRAM, SEE THE LICENSE FOR DETAILS.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="font-bold uppercase tracking-wider text-xs text-ink-muted">
              Card Set Credits
            </h3>

            <ul className="space-y-1 list-disc list-inside opacity-90">
              <li>
                <strong>Atlasnye</strong>: CC0 by Dmitry Fomin (
                <a
                  href="https://commons.wikimedia.org/wiki/Category:SVG_Atlasnye_playing_cards"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Wikimedia
                </a>
                )
              </li>

              <li>
                <strong>Brescia</strong>: CC BY-SA 4.0 by ZZandro (
                <a
                  href="https://commons.wikimedia.org/wiki/Category:Brescia_deck"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Wikimedia
                </a>
                )
              </li>

              <li>
                <strong>Digital Design Labs</strong>: LGPL 3.0 / Mike Hall &
                Chris Aguilar (
                <a
                  href="https://github.com/digitaldesignlabs/responsive-playing-cards"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  GitHub
                </a>
                )
              </li>

              <li>
                <strong>SVG-cards</strong>: LGPL-2.1 by htdebeer (
                <a
                  href="https://github.com/htdebeer/SVG-cards"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  GitHub
                </a>
                )
              </li>

              <li>
                <strong>Vector Playing Cards</strong>: Public Domain by Byron
                Knoll / notpeter (
                <a
                  href="https://github.com/notpeter/Vector-Playing-Cards"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  GitHub
                </a>
                )
              </li>

              <li>
                <strong>Adrian Kennard</strong>: CC0 (
                <a
                  href="https://www.me.uk/cards/makeadeck.cgi"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Make-a-deck
                </a>
                )
              </li>

              <li>
                <strong>David Bellot</strong>: LGPL v3 (
                <a
                  href="https://commons.wikimedia.org/wiki/File:Card_back_01.svg"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Card back
                </a>
                ,{" "}
                <a
                  href="https://commons.wikimedia.org/wiki/File:Joker_red_02.svg"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Red
                </a>{" "}
                and{" "}
                <a
                  href="https://commons.wikimedia.org/wiki/File:Joker_black_02.svg"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Black
                </a>{" "}
                Jokers)
              </li>
            </ul>
          </section>

          <section className="space-y-2">
            <h3 className="font-bold uppercase tracking-wider text-xs text-ink-muted">
              Rule Sources
            </h3>
            <p className="leading-relaxed">
              Many game rules are based on the authoritative documentation at{" "}
              <a
                href="https://www.pagat.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Pagat.com
              </a>
              , edited by John McLeod.
            </p>
          </section>
        </ScrollShadowWrapper>

        {/* Footer */}
        <div className="p-4 border-t border-surface-2 bg-surface-1/50 flex items-center justify-between">
          <button
            onClick={handleCopyVersion}
            className="about-modal-version font-mono text-[10px] text-ink-muted opacity-60 truncate px-2 hover:text-ink hover:opacity-100 transition-all cursor-pointer focus:outline-none active:scale-95"
            title="Click to copy version info"
          >
            version #{commitHash} {commitDate}
          </button>
          <button
            onClick={onClose}
            className="about-modal-footer button-base button-secondary px-4 py-2 text-sm"
          >
            Close
          </button>
        </div>
      </div>
    </Overlay>
  );
}
