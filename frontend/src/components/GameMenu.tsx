import { useRef, useState, useEffect } from "react";
import { useAtom } from "jotai";
import {
  themeSettingAtom,
  cardSetAtom,
  moveTypeAtom,
  freeDragEnabledAtom,
  soundEnabledAtom,
  autoRotateSeatAtom,
  toastAutoCloseEnabledAtom,
  isMenuOpenAtom,
} from "../state";
import { CARD_SETS, findCardSetById } from "../cardSets";
import { ScrollShadowWrapper } from "./ScrollShadowWrapper";
import { safeStartViewTransition } from "../utils/viewTransition";

interface GameMenuProps {
  gameId: string;
  seed: string;
  onResetSeed: () => void;
  isSpectator: boolean;
  isGodMode: boolean;
  onToggleGodMode: () => void;
  onRestartHand: () => void;
  onExit: () => void;
  onAbout: () => void;
  displayName: string;
  isBlocked?: boolean;
}

export function GameMenu({
  gameId,
  seed,
  onResetSeed,
  isSpectator,
  isGodMode,
  onToggleGodMode,
  onRestartHand,
  onExit,
  onAbout,
  displayName,
  isBlocked = false,
}: GameMenuProps) {
  const [isOpen, setIsOpen] = useAtom(isMenuOpenAtom);
  const [theme, setTheme] = useAtom(themeSettingAtom);
  const [cardSetId, setCardSet] = useAtom(cardSetAtom);
  const [moveType, setMoveType] = useAtom(moveTypeAtom);
  const [freeDragEnabled, setFreeDragEnabled] = useAtom(freeDragEnabledAtom);
  const [soundEnabled, setSoundEnabled] = useAtom(soundEnabledAtom);
  const [autoRotateSeat, setAutoRotateSeat] = useAtom(autoRotateSeatAtom);
  const [toastAutoCloseEnabled, setToastAutoCloseEnabled] = useAtom(
    toastAutoCloseEnabledAtom
  );

  const contentRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!isOpen || isBlocked) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        safeStartViewTransition(() => setIsOpen(false));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, setIsOpen, isBlocked]);

  // Temporary state for the copy feedback on the header buttons
  const [headerCopySuccess, setHeaderCopySuccess] = useState(false);
  const [seedCopySuccess, setSeedCopySuccess] = useState(false);

  if (!isOpen) return null;

  const handleBackdropClick = () => {
    if (!isBlocked) {
      safeStartViewTransition(() => setIsOpen(false));
    }
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error("Failed to copy", err);
    }
  };

  const handleHeaderCopy = async () => {
    await handleCopy(gameId);
    setHeaderCopySuccess(true);
    setTimeout(() => setHeaderCopySuccess(false), 2000);
  };

  const handleSeedCopy = async () => {
    await handleCopy(seed);
    setSeedCopySuccess(true);
    setTimeout(() => setSeedCopySuccess(false), 2000);
  };

  const getCardUrl = (setId: string, card: string) => {
    const set = findCardSetById(setId);
    const assetBase = set?.path ? `/cards/${set.path}/` : `/cards/${setId}/`;
    return `${assetBase}${card}.svg`;
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 sm:p-6"
      onClick={handleBackdropClick}
      style={{ viewTransitionName: "game-menu-backdrop" }}
    >
      <div
        className="relative w-full max-w-[1280px] h-full max-h-[820px] bg-surface-1 rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-surface-3"
        onClick={(e) => e.stopPropagation()}
        style={{ viewTransitionName: "game-menu-content" }}
      >
        {/* Header: Unified Title, Room ID, and Seed */}
        <div className="flex items-center justify-between px-4 py-3 sm:px-6 sm:py-4 border-b border-surface-3 bg-surface-2/50 shrink-0">
          <div className="flex items-center gap-2 sm:gap-3 overflow-hidden">
            <h2 className="text-lg sm:text-xl font-bold text-ink truncate max-w-[120px] xs:max-w-none">
              {displayName}
            </h2>
            <div className="h-4 w-px bg-ink-muted/30 shrink-0" />
            <div className="flex items-center gap-2 sm:gap-4 min-w-0">
              {/* Room ID */}
              <div className="flex items-center gap-1 sm:gap-2 min-w-0">
                <span className="hidden xs:inline text-[10px] sm:text-2xs font-semibold text-ink-muted uppercase tracking-wider shrink-0">
                  Room
                </span>
                <button
                  onClick={handleHeaderCopy}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-surface-1 border border-surface-3 hover:bg-surface-3 hover:border-surface-4 transition-all group min-w-0"
                  title="Copy Room ID"
                >
                  <code className="font-mono text-[11px] sm:text-xs text-ink truncate max-w-[60px] sm:max-w-none">
                    {gameId}
                  </code>
                  {headerCopySuccess ? (
                    <svg
                      className="w-3 h-3 text-green-600 shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  ) : (
                    <svg
                      className="w-3 h-3 text-ink-muted group-hover:text-ink transition-colors shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                      />
                    </svg>
                  )}
                </button>
              </div>

              <div className="h-4 w-px bg-ink-muted/30 shrink-0" />

              {/* Seed */}
              <div className="flex items-center gap-1 sm:gap-2 min-w-0">
                <span className="hidden xs:inline text-[10px] sm:text-2xs font-semibold text-ink-muted uppercase tracking-wider shrink-0">
                  Seed
                </span>
                <button
                  onClick={handleSeedCopy}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-surface-1 border border-surface-3 hover:bg-surface-3 hover:border-surface-4 transition-all group min-w-0"
                  title="Copy Seed"
                >
                  <code className="font-mono text-[11px] sm:text-xs text-ink truncate max-w-[60px] sm:max-w-none">
                    {seed}
                  </code>
                  {seedCopySuccess ? (
                    <svg
                      className="w-3 h-3 text-green-600 shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  ) : (
                    <svg
                      className="w-3 h-3 text-ink-muted group-hover:text-ink transition-colors shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                      />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>
          <button
            onClick={() => safeStartViewTransition(() => setIsOpen(false))}
            className="p-1 sm:p-2 -mr-1 sm:-mr-2 rounded-full hover:bg-surface-3 transition-colors text-ink-muted hover:text-ink shrink-0"
            aria-label="Close menu"
          >
            <svg
              className="w-5 h-5 sm:w-6 sm:h-6"
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
          className="flex-1 overflow-y-auto"
          scrollRef={contentRef}
        >
          <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left Column: Visuals */}
            <div className="space-y-6">
              {/* Theme Section */}
              <section className="bg-surface-2 rounded-xl p-5 border border-surface-3">
                <h3 className="text-sm font-bold uppercase tracking-wider text-ink-muted mb-4">
                  Theme
                </h3>

                <div className="grid grid-cols-3 gap-3">
                  {(["light", "dark", "system"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTheme(t)}
                      className={`
                        relative flex flex-col items-center p-2 rounded-xl border-2 transition-all
                        ${
                          theme === t
                            ? "border-primary bg-primary/5 shadow-sm"
                            : "border-surface-3 bg-surface-1 hover:border-surface-4"
                        }
                      `}
                    >
                      {/* Theme Icon Preview */}
                      <div
                        className={`w-full aspect-video rounded-lg mb-2 flex items-center justify-center border shadow-sm transition-colors ${
                          t === "light"
                            ? "bg-white border-gray-200 text-slate-600"
                            : t === "dark"
                              ? "bg-slate-900 border-slate-700 text-slate-400"
                              : "bg-surface-3 border-surface-4 text-ink"
                        }`}
                      >
                        {t === "system" ? (
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                            strokeWidth={1.5}
                            stroke="currentColor"
                            className="w-6 h-6"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25"
                            />
                          </svg>
                        ) : t === "dark" ? (
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
                              d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
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
                              d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                            />
                          </svg>
                        )}
                      </div>

                      <span
                        className={`text-xs font-semibold ${theme === t ? "text-primary" : "text-ink"}`}
                      >
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              {/* Card Design Section */}
              <section className="bg-surface-2 rounded-xl p-5 border border-surface-3">
                <h3 className="text-sm font-bold uppercase tracking-wider text-ink-muted mb-4">
                  Card Design
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-2 gap-3">
                  {CARD_SETS.map((set) => (
                    <button
                      key={set.id}
                      onClick={() => setCardSet(set.id)}
                      className={`
                        relative flex items-center p-3 rounded-xl border-2 transition-all group overflow-hidden text-left gap-3
                        ${
                          cardSetId === set.id
                            ? "border-primary bg-primary/5 shadow-sm"
                            : "border-surface-3 bg-surface-1 hover:border-surface-4"
                        }
                      `}
                    >
                      {/* Card Fan Preview */}
                      <div className="relative h-12 w-24 shrink-0">
                        <img
                          src={getCardUrl(set.id, "AS")}
                          alt=""
                          loading="lazy"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                          className="absolute top-0 left-0 h-full w-auto object-contain shadow-sm transform -rotate-12 origin-bottom transition-transform group-hover:-translate-y-1"
                          style={{ zIndex: 40 }}
                        />
                        <img
                          src={getCardUrl(set.id, "7C")}
                          alt=""
                          loading="lazy"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                          className="absolute top-0 left-4 h-full w-auto object-contain shadow-sm transform -rotate-4 origin-bottom transition-transform"
                          style={{ zIndex: 10 }}
                        />
                        <img
                          src={getCardUrl(set.id, "QH")}
                          alt=""
                          loading="lazy"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                          className="absolute top-0 left-8 h-full w-auto object-contain shadow-sm transform rotate-4 origin-bottom transition-transform group-hover:-translate-y-1"
                          style={{ zIndex: 30 }}
                        />
                        <img
                          src={getCardUrl(set.id, "2D")}
                          alt=""
                          loading="lazy"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                          className="absolute top-0 left-12 h-full w-auto object-contain shadow-sm transform rotate-12 origin-bottom transition-transform"
                          style={{ zIndex: 20 }}
                        />
                      </div>

                      <div className="flex-1 min-w-0">
                        <span
                          className={`text-xs font-semibold block truncate ${cardSetId === set.id ? "text-primary" : "text-ink"}`}
                        >
                          {set.label}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            </div>

            {/* Right Column: Restart & Preferences */}
            <div className="flex flex-col gap-6">
              {/* Restart & Quit Section */}
              <section className="bg-surface-2 rounded-xl p-5 border border-surface-3 flex flex-col">
                <h3 className="text-sm font-bold uppercase tracking-wider text-ink-muted mb-4">
                  Restart & Quit
                </h3>

                <div className="grid grid-cols-1 gap-3">
                  {/* Restart Hand */}
                  <div className="p-4 bg-surface-1 rounded-xl border border-surface-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h4 className="font-semibold text-ink text-sm mb-0.5">
                        Restart Hand
                      </h4>
                      <p className="text-xs text-ink-muted leading-relaxed">
                        Replay the current hand from the beginning using the
                        same seed.
                      </p>
                    </div>
                    <div className="flex sm:justify-end shrink-0">
                      <button
                        onClick={onRestartHand}
                        className="w-full sm:w-40 px-6 py-2 bg-surface-2 border border-surface-3 hover:border-surface-4 hover:bg-surface-3 text-ink text-sm font-semibold rounded-lg transition-colors shadow-sm"
                      >
                        Restart Hand
                      </button>
                    </div>
                  </div>

                  {/* New Hand */}
                  <div className="p-4 bg-surface-1 rounded-xl border border-surface-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h4 className="font-semibold text-ink text-sm mb-0.5">
                        Shuffle a New Hand
                      </h4>
                      <p className="text-xs text-ink-muted leading-relaxed">
                        Reset with a new seed to deal a completely fresh hand.
                      </p>
                    </div>

                    <div className="flex sm:justify-end shrink-0">
                      <button
                        onClick={onResetSeed}
                        className="w-full sm:w-40 px-6 py-2 text-sm font-semibold rounded-lg transition-colors border bg-surface-2 border-surface-3 hover:border-surface-4 text-ink hover:bg-surface-3 shadow-sm"
                      >
                        New Hand
                      </button>
                    </div>
                  </div>

                  {/* Quit Game */}
                  <div className="p-4 bg-surface-1 rounded-xl border border-surface-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h4 className="font-semibold text-ink text-sm mb-0.5">
                        Quit Game
                      </h4>
                      <p className="text-xs text-ink-muted leading-relaxed">
                        Leave your seat and return to the room lobby.
                      </p>
                    </div>
                    <div className="flex sm:justify-end shrink-0">
                      <button
                        onClick={onExit}
                        className="w-full sm:w-40 px-6 py-2 bg-red-600 hover:bg-red-700 text-white font-bold text-sm rounded-lg shadow-sm transition-colors flex items-center justify-center gap-2"
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                          />
                        </svg>
                        Quit Game
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              {/* Preferences Section */}
              <section className="bg-surface-2 rounded-xl p-5 border border-surface-3">
                <h3 className="text-sm font-bold uppercase tracking-wider text-ink-muted mb-4">
                  Preferences
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-2 gap-3">
                  <MenuToggle
                    label="Sound Effects"
                    enabled={soundEnabled}
                    onChange={() => setSoundEnabled((prev) => !prev)}
                  />
                  <MenuToggle
                    label="Auto-rotate View"
                    enabled={autoRotateSeat}
                    onChange={() => setAutoRotateSeat((prev) => !prev)}
                  />
                  <MenuToggle
                    label="Auto-close Messages"
                    enabled={toastAutoCloseEnabled}
                    onChange={() => setToastAutoCloseEnabled((prev) => !prev)}
                  />

                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-surface-1 border border-surface-3">
                    <span className="text-xs font-medium text-ink ml-1">
                      Input
                    </span>
                    <div className="flex bg-surface-3 rounded-md p-0.5">
                      <button
                        onClick={() => setMoveType("click")}
                        className={`px-3 py-1 rounded text-2xs font-bold uppercase tracking-wider transition-all ${
                          moveType === "click"
                            ? "bg-surface-1 text-ink shadow-sm"
                            : "text-ink-muted hover:text-ink"
                        }`}
                      >
                        Click
                      </button>
                      <button
                        onClick={() => setMoveType("drag")}
                        className={`px-3 py-1 rounded text-2xs font-bold uppercase tracking-wider transition-all ${
                          moveType === "drag"
                            ? "bg-surface-1 text-ink shadow-sm"
                            : "text-ink-muted hover:text-ink"
                        }`}
                      >
                        Drag
                      </button>
                    </div>
                  </div>

                  <MenuToggle
                    label="Free Drag"
                    enabled={freeDragEnabled}
                    onChange={() => setFreeDragEnabled((prev) => !prev)}
                  />

                  {isSpectator && (
                    <MenuToggle
                      label="God Mode"
                      enabled={isGodMode}
                      onChange={onToggleGodMode}
                    />
                  )}
                </div>
              </section>

              {/* About & Close Buttons - Right-aligned below sections */}
              <div className="flex justify-end gap-3 mt-auto pt-2">
                <button
                  onClick={onAbout}
                  className="py-2 px-6 bg-surface-1 border border-surface-3 hover:bg-surface-3 text-ink font-medium text-xs rounded-lg transition-colors shadow-sm"
                >
                  About
                </button>
                <button
                  onClick={() =>
                    safeStartViewTransition(() => setIsOpen(false))
                  }
                  className="py-2 px-6 bg-surface-1 border border-surface-3 hover:bg-surface-3 text-ink font-medium text-xs rounded-lg transition-colors shadow-sm"
                >
                  Back to Game
                </button>
              </div>
            </div>
          </div>
        </ScrollShadowWrapper>
      </div>
    </div>
  );
}

function MenuToggle({
  label,
  enabled,
  onChange,
  warning = false,
}: {
  label: string;
  enabled: boolean;
  onChange: () => void;
  warning?: boolean;
}) {
  return (
    <button
      onClick={onChange}
      className={`
        w-full flex items-center justify-between p-2.5 rounded-lg border transition-all text-left
        ${
          enabled
            ? "bg-surface-1 border-primary/30"
            : "bg-surface-1 border-surface-3 hover:border-surface-4"
        }
      `}
    >
      <div
        className={`text-xs font-medium ${enabled ? "text-primary" : "text-ink"}`}
      >
        {label}
      </div>
      <div
        className={`
        w-8 h-5 rounded-full p-0.5 transition-colors relative
        ${enabled ? (warning ? "bg-orange-500" : "bg-primary") : "bg-surface-3"}
      `}
      >
        <div
          className={`
          w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200
          ${enabled ? "translate-x-3" : "translate-x-0"}
        `}
        />
      </div>
    </button>
  );
}
