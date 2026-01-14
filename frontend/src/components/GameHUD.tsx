import { useMemo, useEffect, useState, useCallback, useRef } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  availableGamesAtom,
  rulesIdAtom,
  gameViewAtom,
  aiLogAtom,
  allSeatsAutomatedAtom,
  freeDragEnabledAtom,
  toastAutoCloseEnabledAtom,
  soundEnabledAtom,
  autoRotateSeatAtom,
  statusMessageAtom,
} from "../state";
import type { AiLogEntry } from "../state";

import { resetGameWithSeed, setGodMode } from "../socket";
import { ConfirmationOverlay } from "./ConfirmationOverlay";
import { useAiLog } from "../hooks/useAiLog";
import { sfx } from "../utils/audio";
import { shareGameInfo } from "../utils/share";
import { copyToClipboard } from "../utils/clipboard";
import { ScrollShadowWrapper } from "./ScrollShadowWrapper";

interface GameHUDProps {
  gameId: string;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  onExit: () => void;
  onReset: () => void;
  onChangeTheme: () => void;
  themeLabel: string;
  onChangeCardSet: () => void;
  cardSetLabel: string;
  onAboutClick?: () => void;
}

type ConfirmType = "restartHand" | "exit" | "restartSeed" | null;

export function GameHUD({
  gameId,
  isOpen,
  setIsOpen,
  onExit,
  onReset,
  onChangeTheme,
  themeLabel,
  onChangeCardSet,
  cardSetLabel,
  onAboutClick,
}: GameHUDProps) {
  const view = useAtomValue(gameViewAtom);
  const rulesId = useAtomValue(rulesIdAtom);
  const availableGames = useAtomValue(availableGamesAtom);
  const { isAiLogVisible, setAiLogVisible } = useAiLog();
  const aiLog = useAtomValue(aiLogAtom);
  const allSeatsAutomated = useAtomValue(allSeatsAutomatedAtom);
  const [freeDragEnabled, setFreeDragEnabled] = useAtom(freeDragEnabledAtom);
  const [toastAutoCloseEnabled, setToastAutoCloseEnabled] = useAtom(
    toastAutoCloseEnabledAtom
  );
  const [soundEnabled, setSoundEnabled] = useAtom(soundEnabledAtom);
  const [autoRotateSeat, setAutoRotateSeat] = useAtom(autoRotateSeatAtom);
  const addStatusMessage = useSetAtom(statusMessageAtom);

  const showToast = useCallback(
    (
      message: string,
      tone: "success" | "error" | "neutral" | "warning" = "success"
    ) => {
      const id = Date.now() + Math.random();
      addStatusMessage((prev) => [
        { id, message, tone, source: "app" },
        ...prev,
      ]);

      if (toastAutoCloseEnabled) {
        setTimeout(() => {
          addStatusMessage((prev) => prev.filter((m) => m.id !== id));
        }, 3000);
      }
    },
    [addStatusMessage, toastAutoCloseEnabled]
  );

  const handleCopy = useCallback(
    async (text: string, label: string) => {
      const success = await copyToClipboard(text);
      if (!success) {
        showToast(`Failed to copy ${label}`, "error");
      }
    },
    [showToast]
  );

  // Sync sound state with audio engine
  useEffect(() => {
    sfx.setEnabled(soundEnabled);
  }, [soundEnabled]);

  const [confirmType, setConfirmType] = useState<ConfirmType>(null);
  const [pendingSeed, setPendingSeed] = useState<string | null>(null);

  const currentGameType = view?.rulesId ?? rulesId ?? "";
  const displayName =
    availableGames?.find((g) => g.id === currentGameType)?.name ??
    currentGameType ??
    "Game";

  const seed =
    (view?.metadata && typeof view.metadata.seed === "string"
      ? view.metadata.seed
      : null) || "Unknown";
  const isSpectator = view?.metadata?.role === "spectator";
  const isGodMode = view?.metadata?.isGodMode === "true";
  const roomCloseDelayMinutes = 5;
  const exitNotice = allSeatsAutomated
    ? "AI-only rooms close immediately once the last human leaves."
    : `Rooms close after ${roomCloseDelayMinutes} minutes once all humans have left.`;

  const generateSeed = (): string => {
    if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
      const bytes = new Uint8Array(4);
      crypto.getRandomValues(bytes);
      const value =
        (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
      return (value >>> 0).toString(36).toUpperCase().slice(0, 6);
    }
    return Math.random().toString(36).slice(2, 8).toUpperCase();
  };

  const handleResetSeed = () => {
    if (!gameId) return;
    setPendingSeed(generateSeed());
    setConfirmType("restartSeed");
  };

  const confirmResetSeed = () => {
    if (!gameId) return;
    const nextSeed = pendingSeed ?? generateSeed();
    resetGameWithSeed(gameId, nextSeed);
    setPendingSeed(null);
    setConfirmType(null);
  };

  const { groupedByTurn, renderedAiLogCount } = useMemo(() => {
    const filteredAiLog = aiLog.filter(isRenderableAiLogEntry);
    const groups = new Map<
      number,
      { playerId: string | null; entries: AiLogEntry[] }
    >();

    for (const entry of filteredAiLog) {
      const existing = groups.get(entry.turnNumber);
      if (!existing) {
        groups.set(entry.turnNumber, {
          playerId: entry.playerId,
          entries: [entry],
        });
      } else {
        existing.entries.push(entry);
      }
    }

    const grouped = Array.from(groups.entries())
      .sort(([a], [b]) => a - b)
      .map(([turnNumber, { playerId, entries }]) => ({
        turnNumber,
        playerId,
        entries: entries.sort(
          (a, b) =>
            new Date(a.timestamp ?? 0).getTime() -
            new Date(b.timestamp ?? 0).getTime()
        ),
      }));
    return { groupedByTurn: grouped, renderedAiLogCount: filteredAiLog.length };
  }, [aiLog]);

  const seatMetaById = useMemo(() => {
    const map = new Map<string, { label: string; aiRuntime?: string }>();
    for (const seat of view?.seats ?? []) {
      map.set(seat.seatId, {
        label: seat.name ?? seat.seatId,
        aiRuntime: seat.aiRuntime,
      });
    }
    return map;
  }, [view?.seats]);

  const formatTurnHeading = (
    turnNumber: number,
    playerId: string | null
  ): string => {
    const turnLabel = turnNumber > 0 ? `Turn ${turnNumber}` : "Setup";
    if (!playerId) return turnLabel;
    const meta = seatMetaById.get(playerId);
    const seatLabel = meta?.label ?? playerId;
    if (!meta) return `${turnLabel} · ${seatLabel}`;
    let roleLabel = "Human";
    if (meta.aiRuntime && meta.aiRuntime !== "none") {
      roleLabel =
        meta.aiRuntime === "backend"
          ? "AI - server"
          : meta.aiRuntime === "frontend"
            ? "AI - browser"
            : "AI";
    }
    return `${turnLabel} · ${seatLabel} (${roleLabel})`;
  };

  const aiLogScrollRef = useRef<HTMLDivElement>(null);
  const aiLogAutoScrollRef = useRef(true);

  const handleAiLogScroll = useCallback(() => {
    const node = aiLogScrollRef.current;
    if (!node) return;
    const threshold = 48;
    const distanceFromBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight;
    aiLogAutoScrollRef.current = distanceFromBottom <= threshold;
  }, []);

  useEffect(() => {
    if (!isAiLogVisible) return;
    const node = aiLogScrollRef.current;
    if (!node) return;
    aiLogAutoScrollRef.current = true;
    node.scrollTop = node.scrollHeight;
  }, [isAiLogVisible]);

  useEffect(() => {
    if (!isAiLogVisible) return;
    const node = aiLogScrollRef.current;
    if (!node || !aiLogAutoScrollRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [isAiLogVisible, renderedAiLogCount]);

  const handleToggleGodMode = () => {
    if (!gameId) return;
    setGodMode(gameId, !isGodMode);
  };

  const HUDToggle = ({
    label,
    enabled,
    onClick,
    title,
  }: {
    label: string;
    enabled: boolean;
    onClick: () => void;
    title?: string;
  }) => (
    <button
      onClick={onClick}
      className="button-base button-ghost flex items-center justify-center w-full landscape:w-auto px-2 py-2 text-sm text-ink"
      title={title}
    >
      <span
        className={`text-[10px] sm:text-xs px-2.5 py-1.5 rounded-full font-bold uppercase tracking-wider transition-all whitespace-nowrap flex items-center gap-2 border w-full landscape:w-auto ${
          enabled
            ? "bg-success-surface text-success-ink border-success/30 shadow-sm"
            : "bg-surface-3/50 text-ink-muted border-transparent"
        }`}
      >
        <span className="flex-1 text-left landscape:flex-none">{label}</span>
        <span
          className={`w-1.5 h-1.5 rounded-full transition-colors ${
            enabled ? "bg-success" : "bg-ink-muted/40"
          }`}
        />
        <span className="opacity-70 font-black">{enabled ? "On" : "Off"}</span>
      </span>
    </button>
  );

  const HUDValue = ({
    label,
    value,
    onClick,
    title,
  }: {
    label: string;
    value: string;
    onClick: () => void;
    title?: string;
  }) => (
    <button
      onClick={onClick}
      className="button-base button-ghost flex items-center justify-center w-full landscape:w-auto px-2 py-2 text-sm text-ink"
      title={title}
    >
      <span className="text-[10px] sm:text-xs text-ink-muted bg-surface-3 px-2.5 py-1.5 rounded-full font-bold uppercase tracking-wider whitespace-nowrap flex items-center border border-transparent w-full landscape:w-auto">
        <span className="text-ink/50 mr-2 flex-1 text-left landscape:flex-none">
          {label}
        </span>
        <span className="text-ink">{value}</span>
      </span>
    </button>
  );

  return (
    <>
      {confirmType === "restartSeed" && (
        <ConfirmationOverlay
          title="Restart with a new shuffle seed?"
          description="This resets the current hand and deals a fresh shuffle."
          confirmLabel="Restart"
          onConfirm={confirmResetSeed}
          onCancel={() => setConfirmType(null)}
        >
          <div className="grid grid-cols-[auto_auto] items-center gap-x-3 gap-y-2 text-sm">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted text-right">
              Current seed
            </span>
            <button
              type="button"
              onClick={() => handleCopy(seed, "Seed")}
              className="font-mono text-xs text-ink bg-surface-2 px-2 py-1 rounded whitespace-nowrap hover:bg-surface-3 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-surface-4"
              title="Copy current seed"
            >
              {seed}
            </button>
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted text-right">
              New seed
            </span>
            <button
              type="button"
              onClick={() => {
                if (pendingSeed) handleCopy(pendingSeed, "New seed");
              }}
              className="font-mono text-xs text-ink bg-surface-2 px-2 py-1 rounded whitespace-nowrap hover:bg-surface-3 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-surface-4"
              title="Copy new seed"
            >
              {pendingSeed ?? "Generating..."}
            </button>
          </div>
        </ConfirmationOverlay>
      )}

      {confirmType === "restartHand" && (
        <ConfirmationOverlay
          title="Restart this hand?"
          description="The current hand will be reset to its initial state using the same shuffle."
          confirmLabel="Restart Hand"
          onConfirm={() => {
            onReset();
            setConfirmType(null);
          }}
          onCancel={() => setConfirmType(null)}
        />
      )}

      {confirmType === "exit" && (
        <ConfirmationOverlay
          title="Exit to room lobby?"
          description={`You will leave your seat and return to the room lobby. ${exitNotice}`}
          confirmLabel="Exit to Lobby"
          onConfirm={() => {
            onExit();
            setConfirmType(null);
          }}
          onCancel={() => setConfirmType(null)}
        />
      )}

      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 transition-opacity duration-300 pointer-events-auto"
          onClick={() => setIsOpen(false)}
        />
      )}

      <div
        className={`game-hud-wrapper header-protrude fixed top-16 left-2 sm:left-4 z-50 pointer-events-none transition-all duration-300 origin-top-left translate-x-0 translate-y-0 ${
          isOpen
            ? "opacity-100 scale-100 visible"
            : "opacity-0 scale-95 invisible"
        }`}
        data-open={isOpen}
      >
        <div className="pointer-events-auto hud-menu">
          <ScrollShadowWrapper className="w-64 sm:w-auto max-w-[calc(100vw-2rem)] max-h-[95vh] glass-panel rounded-xl shadow-floating bg-surface-1/80 backdrop-blur-md border border-surface-3">
            <div className="p-2 flex flex-col landscape:flex-row landscape:flex-wrap landscape:items-center gap-1 w-fit min-w-full">
              <div className="px-3 py-2 border-b landscape:border-b-0 landscape:border-r border-surface-3 mb-1 landscape:mb-0 flex flex-col sm:flex-row justify-between landscape:justify-start landscape:gap-3 items-start sm:items-center">
                <span className="text-[10px] text-ink-muted uppercase font-bold tracking-wider mb-1 sm:mb-0">
                  Room ID
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleCopy(gameId, "Room ID")}
                    className="font-mono text-xs text-ink bg-surface-2 px-1.5 py-0.5 rounded whitespace-nowrap leading-tight hover:bg-surface-3 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-surface-4"
                    title="Copy room ID"
                  >
                    {gameId}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await shareGameInfo(displayName || undefined);
                      } catch (err) {
                        console.error("Failed to share game info", err);
                      }
                    }}
                    className="button-base button-icon button-secondary h-6 w-6"
                    title="Share game"
                  >
                    <svg
                      className="h-3.5 w-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                      <polyline points="16,6 12,2 8,6" />
                      <line x1="12" y1="2" x2="12" y2="15" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="px-3 py-2 border-b landscape:border-b-0 landscape:border-r border-surface-3 mb-1 landscape:mb-0 flex flex-col sm:flex-row justify-between landscape:justify-start landscape:gap-3 items-start sm:items-center">
                <span className="text-[10px] text-ink-muted uppercase font-bold tracking-wider mb-1 sm:mb-0">
                  Seed
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleCopy(seed, "Seed")}
                    className="font-mono text-xs text-ink bg-surface-2 px-1.5 py-0.5 rounded whitespace-nowrap hover:bg-surface-3 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-surface-4"
                    title="Copy seed"
                  >
                    {seed}
                  </button>
                  <button
                    type="button"
                    onClick={handleResetSeed}
                    className="button-base button-icon button-secondary h-6 w-6"
                    title="Restart with a new seed"
                  >
                    <svg
                      className="h-3.5 w-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M3 12a9 9 0 1 0 3-6.7" />
                      <path d="M3 4v6h6" />
                    </svg>
                  </button>
                </div>
              </div>

              <HUDValue
                label="Cards"
                value={cardSetLabel}
                onClick={onChangeCardSet}
                title="Change card design"
              />

              <HUDValue
                label="Theme"
                value={themeLabel}
                onClick={onChangeTheme}
                title="Change tabletop theme"
              />

              <HUDToggle
                label="Free drag"
                enabled={freeDragEnabled}
                onClick={() => setFreeDragEnabled((prev) => !prev)}
                title="Allow dragging any card (debug)"
              />

              <HUDToggle
                label="Auto-close"
                enabled={toastAutoCloseEnabled}
                onClick={() => setToastAutoCloseEnabled((prev) => !prev)}
                title="Automatically hide status messages"
              />

              <HUDToggle
                label="Sound"
                enabled={soundEnabled}
                onClick={() => setSoundEnabled((prev) => !prev)}
                title="Toggle game sound effects"
              />

              <HUDToggle
                label="Auto-rotate"
                enabled={autoRotateSeat}
                onClick={() => setAutoRotateSeat((prev) => !prev)}
                title="Rotate view so you always sit at the bottom"
              />

              {isSpectator && (
                <HUDToggle
                  label="God mode"
                  enabled={isGodMode}
                  onClick={handleToggleGodMode}
                  title="Enable all actions for debugging"
                />
              )}

              <div className="h-px w-full landscape:w-px landscape:h-8 bg-surface-3 my-1 landscape:my-0" />

              <button
                onClick={() => setConfirmType("restartHand")}
                className="button-base button-danger flex flex-col sm:flex-row justify-between landscape:justify-start landscape:gap-3 items-start sm:items-center w-full landscape:w-auto px-4 py-2.5 text-sm font-medium"
              >
                <span className="font-medium mb-1 sm:mb-0">
                  Restart{" "}
                  <span className="landscape:hidden xl:landscape:inline">
                    Hand
                  </span>
                </span>
              </button>

              <button
                onClick={() => setConfirmType("exit")}
                className="button-base button-secondary flex flex-col sm:flex-row justify-between landscape:justify-start landscape:gap-3 items-start sm:items-center w-full landscape:w-auto px-4 py-2.5 text-sm text-red-600 hover:text-red-700"
                title="Return to room lobby"
              >
                <span className="font-medium mb-1 sm:mb-0">Exit</span>
              </button>

              {onAboutClick && (
                <button
                  onClick={onAboutClick}
                  className="button-base button-ghost flex items-center justify-center w-full landscape:w-auto px-2 py-2 text-sm text-ink"
                  title="View license and credits"
                >
                  <span className="text-[10px] sm:text-xs text-ink-muted bg-surface-3 px-2.5 py-1.5 rounded-full font-bold uppercase tracking-wider whitespace-nowrap flex items-center border border-transparent w-full landscape:w-auto">
                    About
                  </span>
                </button>
              )}
            </div>
          </ScrollShadowWrapper>
        </div>
      </div>

      {/* --- Game Log Modal --- */}
      {isAiLogVisible && (
        <>
          <div
            className="fixed inset-0 z-[125] bg-black/60 pointer-events-auto"
            onClick={() => setAiLogVisible(false)}
          />

          <div className="ai-log-modal fixed inset-x-4 inset-y-16 z-[130] max-h-[80vh] overflow-hidden rounded-xl bg-surface-1 border border-surface-3 shadow-xl flex flex-col pb-4">
            <div className="px-4 py-3 border-b border-surface-3 flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="ai-log-title text-sm font-bold text-indigo-600 uppercase tracking-wide">
                    Game log
                  </span>
                  <div className="flex gap-1.5 flex-wrap">
                    <div className="flex items-center gap-1">
                      <span className="ai-log-meta-label text-[10px] text-ink-muted uppercase font-bold">
                        Game
                      </span>
                      <span className="ai-log-meta-value font-mono text-xs text-ink bg-surface-2 px-1.5 py-0.5 rounded">
                        <span className="ai-log-meta-value font-sans text-xs text-ink">
                          {displayName}
                        </span>
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="ai-log-meta-label text-[10px] text-ink-muted uppercase font-bold">
                        Room ID
                      </span>
                      <span className="ai-log-meta-value font-mono text-xs text-ink bg-surface-2 px-1.5 py-0.5 rounded">
                        {gameId}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="ai-log-meta-label text-[10px] text-ink-muted uppercase font-bold">
                        Seed
                      </span>
                      <span className="ai-log-meta-value font-mono text-xs text-ink bg-surface-2 px-1.5 py-0.5 rounded">
                        {seed}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="button-base button-icon text-ink-muted hover:text-ink"
                  onClick={() => {
                    let logContent = `Game log: ${displayName} (room id: ${gameId}, seed ${seed})\n\n`;

                    for (const {
                      turnNumber,
                      playerId,
                      entries,
                    } of groupedByTurn) {
                      logContent += `${formatTurnHeading(
                        turnNumber,
                        playerId
                      )}\n`;
                      for (const entry of entries) {
                        const time = formatTimestampWithMs(
                          entry.timestamp ?? ""
                        );
                        const details = parseAiLogDetails(entry.details);
                        logContent += `${time} ${
                          details
                            ? formatAiLogDetailsForCopy(details, entry.message)
                            : entry.message
                        }\n`;
                      }
                      logContent += "\n";
                    }

                    handleCopy(logContent, "Game log");
                  }}
                  aria-label="Copy log to clipboard"
                >
                  📋
                </button>
                <button
                  type="button"
                  className="button-base button-icon"
                  onClick={() => setAiLogVisible(false)}
                >
                  ✕
                </button>
              </div>
            </div>
            <ScrollShadowWrapper
              className="ai-log-body flex-1 text-xs font-mono bg-surface-2/80"
              scrollRef={aiLogScrollRef}
              onScroll={handleAiLogScroll}
            >
              <div className="px-4 py-3 w-fit min-w-full">
                {groupedByTurn.length === 0 ? (
                  <div className="text-ink-muted px-1">
                    No game log entries yet.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {groupedByTurn.map(({ turnNumber, playerId, entries }) => {
                      return (
                        <div
                          key={turnNumber}
                          className="border border-surface-3 rounded-lg bg-surface-1/90 w-fit min-w-full"
                        >
                          <div className="ai-log-turn-title px-4 py-2 border-b border-surface-3 text-xs uppercase tracking-wide text-ink-muted font-semibold">
                            {formatTurnHeading(turnNumber, playerId)}
                          </div>
                          <ul className="px-4 py-2 space-y-1">
                            {entries.map((entry, idx) => {
                              const time = formatTimestampWithMs(
                                entry.timestamp ?? ""
                              );
                              const details = parseAiLogDetails(entry.details);

                              return (
                                <li
                                  key={`${entry.timestamp ?? idx}-${idx}`}
                                  className="flex gap-2 items-start"
                                >
                                  <span className="text-ink-muted shrink-0 tabular-nums w-[96px]">
                                    {time}
                                  </span>
                                  <button
                                    type="button"
                                    className="button-base button-ghost text-ink-muted hover:text-ink shrink-0 self-start ml-1"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      handleCopy(
                                        details
                                          ? getAiLogCopyPayload(
                                              details,
                                              entry.message
                                            )
                                          : entry.message,
                                        "Game log entry"
                                      );
                                    }}
                                    aria-label="Copy game log entry"
                                  >
                                    📋
                                  </button>
                                  <div className="flex-1 text-ink break-words">
                                    {details
                                      ? renderAiLogDetails(
                                          details,
                                          entry.message
                                        )
                                      : entry.message}
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </ScrollShadowWrapper>
          </div>
        </>
      )}
    </>
  );
}

type AiLogDetails =
  | {
      kind: "candidates";
      candidates: Array<{ id?: string; summary?: string }>;
    }
  | {
      kind: "llm-request";
      url?: string;
      params?: { model?: string; temperature?: number };
      apiKeyMasked?: string;
      messages?: unknown;
    }
  | {
      kind: "llm-response";
      content?: string;
    }
  | {
      kind: "llm-response-raw";
      content?: string;
    }
  | {
      kind: "llm-response-parsed";
      parsed?: unknown;
    }
  | {
      kind: "llm-error";
      error?: string;
      name?: string;
      stack?: string;
      cause?: string;
      causeDetails?: Record<string, unknown>;
      causeChain?: string[];
      status?: number;
      statusText?: string;
      responseBody?: string;
      url?: string;
      params?: { model?: string; temperature?: number };
    }
  | {
      kind: "game-intent";
      intentType: "move" | "action";
      label?: string;
      actionId?: string;
      fromPileId?: string;
      toPileId?: string;
    };

function isRenderableAiLogEntry(entry: AiLogEntry): boolean {
  return !!entry.message || parseAiLogDetails(entry.details) !== null;
}

function parseAiLogDetails(details: unknown): AiLogDetails | null {
  if (!details || typeof details !== "object") return null;
  const record = details as { kind?: unknown };
  if (record.kind === "candidates") {
    const candidates =
      (details as { candidates?: Array<{ id?: string; summary?: string }> })
        .candidates ?? [];
    return { kind: "candidates", candidates };
  }
  if (record.kind === "llm-request") {
    const payload = details as {
      url?: string;
      params?: { model?: string; temperature?: number };
      apiKeyMasked?: string;
      messages?: unknown;
    };
    return {
      kind: "llm-request",
      url: payload.url,
      params: payload.params,
      apiKeyMasked: payload.apiKeyMasked,
      messages: payload.messages,
    };
  }
  if (record.kind === "llm-response") {
    const payload = details as { content?: string };
    return { kind: "llm-response", content: payload.content };
  }
  if (record.kind === "llm-response-raw") {
    const payload = details as { content?: string };
    return { kind: "llm-response-raw", content: payload.content };
  }
  if (record.kind === "llm-response-parsed") {
    const payload = details as { parsed?: unknown };
    return { kind: "llm-response-parsed", parsed: payload.parsed };
  }
  if (record.kind === "llm-error") {
    const payload = details as {
      error?: string;
      name?: string;
      stack?: string;
      cause?: string;
      causeDetails?: Record<string, unknown>;
      causeChain?: string[];
      status?: number;
      statusText?: string;
      responseBody?: string;
      url?: string;
      params?: { model?: string; temperature?: number };
    };
    return {
      kind: "llm-error",
      error: payload.error,
      name: payload.name,
      stack: payload.stack,
      cause: payload.cause,
      causeDetails: payload.causeDetails,
      causeChain: payload.causeChain,
      status: payload.status,
      statusText: payload.statusText,
      responseBody: payload.responseBody,
      url: payload.url,
      params: payload.params,
    };
  }
  if (record.kind === "game-intent") {
    const payload = details as {
      intentType?: string;
      label?: string;
      actionId?: string;
      fromPileId?: string;
      toPileId?: string;
    };
    const intentType = payload.intentType === "action" ? "action" : "move";
    return {
      kind: "game-intent",
      intentType,
      label: typeof payload.label === "string" ? payload.label : undefined,
      actionId:
        typeof payload.actionId === "string" ? payload.actionId : undefined,
      fromPileId:
        typeof payload.fromPileId === "string" ? payload.fromPileId : undefined,
      toPileId:
        typeof payload.toPileId === "string" ? payload.toPileId : undefined,
    };
  }
  return null;
}

function renderAiLogDetails(details: AiLogDetails, fallbackMessage: string) {
  switch (details.kind) {
    case "candidates": {
      const count = details.candidates.length;
      const payload = safeStringify(
        details.candidates.map((candidate) => ({
          id: candidate.id,
          summary: candidate.summary,
        }))
      );
      return (
        <details className="group">
          <summary className="cursor-pointer text-ink">
            Candidates ({count})
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-words text-ink-muted">
            <code>{payload}</code>
          </pre>
        </details>
      );
    }
    case "llm-request": {
      const params = details.params ?? {};
      const model = params.model ?? "unknown";
      const temp =
        typeof params.temperature === "number" ? params.temperature : "unknown";
      const apiKey = details.apiKeyMasked ?? "unset";
      const url = details.url ?? "unknown";
      return (
        <details className="group">
          <summary className="cursor-pointer text-ink">
            Prompt → POST {url} | model={model} | temp={temp} | key={apiKey}
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-words text-ink-muted">
            <code>{safeStringify(details.messages)}</code>
          </pre>
        </details>
      );
    }
    case "llm-response-raw": {
      return (
        <details className="group">
          <summary className="cursor-pointer text-ink">
            Raw LLM Response
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-words text-ink-muted">
            <code>{details.content ?? ""}</code>
          </pre>
        </details>
      );
    }
    case "llm-response": {
      return (
        <details className="group">
          <summary className="cursor-pointer text-ink">
            Parsed LLM Response
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-words text-ink-muted">
            <code>{details.content ?? ""}</code>
          </pre>
        </details>
      );
    }
    case "llm-response-parsed": {
      const compact = toCompactJson(details.parsed);
      return (
        <details className="group">
          <summary className="cursor-pointer text-ink">
            <code>{compact ?? "Parsed LLM Response"}</code>
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-words text-ink-muted">
            <code>{safeStringify(details.parsed)}</code>
          </pre>
        </details>
      );
    }
    case "llm-error": {
      const status =
        details.status != null
          ? `${details.status}${details.statusText ? ` ${details.statusText}` : ""}`
          : "unknown";
      return (
        <details className="group">
          <summary className="cursor-pointer text-red-600">
            Error ({status}) {details.error ?? fallbackMessage}
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-words text-ink-muted">
            <code>
              {safeStringify({
                error: details.error,
                name: details.name,
                stack: details.stack,
                cause: details.cause,
                causeDetails: details.causeDetails,
                causeChain: details.causeChain,
                url: details.url,
                params: details.params,
                responseBody: details.responseBody,
              })}
            </code>
          </pre>
        </details>
      );
    }
    case "game-intent": {
      const label =
        details.label ??
        (details.intentType === "action"
          ? (details.actionId ?? "Action")
          : "Move");
      const prefix = details.intentType === "action" ? "Action" : "Move";
      const fromTo =
        details.intentType === "move" && details.fromPileId && details.toPileId
          ? ` (${details.fromPileId} → ${details.toPileId})`
          : "";
      return (
        <span>
          {prefix}: {label}
          {fromTo}
        </span>
      );
    }
    default:
      return <span>{fallbackMessage}</span>;
  }
}

function formatAiLogDetailsForCopy(
  details: AiLogDetails,
  fallbackMessage: string
): string {
  if (details.kind === "candidates") {
    const lines = details.candidates.map(
      (c) => `- ${c.id ?? "candidate"}${c.summary ? ` — ${c.summary}` : ""}`
    );
    return `Candidates (${details.candidates.length})\n${lines.join("\n")}`;
  }
  if (details.kind === "llm-request") {
    const params = details.params ?? {};
    const model = params.model ?? "unknown";
    const temp =
      typeof params.temperature === "number" ? params.temperature : "unknown";
    return `Prompt → POST ${details.url ?? "unknown"} | model=${model} | temp=${temp} | key=${details.apiKeyMasked ?? "unset"}\n${safeStringify(
      details.messages
    )}`;
  }
  if (details.kind === "llm-response") {
    return `Parsed LLM Response\n${details.content ?? ""}`;
  }
  if (details.kind === "llm-response-raw") {
    return `Raw LLM Response\n${details.content ?? ""}`;
  }
  if (details.kind === "llm-response-parsed") {
    return `Parsed LLM Response\n${safeStringify(details.parsed)}`;
  }
  if (details.kind === "llm-error") {
    const status =
      details.status != null
        ? `${details.status}${details.statusText ? ` ${details.statusText}` : ""}`
        : "unknown";
    return `Error (${status}) ${details.error ?? fallbackMessage}\n${safeStringify(
      {
        error: details.error,
        name: details.name,
        stack: details.stack,
        cause: details.cause,
        causeDetails: details.causeDetails,
        causeChain: details.causeChain,
        url: details.url,
        params: details.params,
        responseBody: details.responseBody,
      }
    )}`;
  }
  if (details.kind === "game-intent") {
    const label =
      details.label ??
      (details.intentType === "action"
        ? (details.actionId ?? "Action")
        : "Move");
    const prefix = details.intentType === "action" ? "Action" : "Move";
    const fromTo =
      details.intentType === "move" && details.fromPileId && details.toPileId
        ? ` (${details.fromPileId} → ${details.toPileId})`
        : "";
    return `${prefix}: ${label}${fromTo}`;
  }
  return fallbackMessage;
}

function getAiLogCopyPayload(
  details: AiLogDetails,
  fallbackMessage: string
): string {
  if (details.kind === "candidates") {
    return safeStringify(
      details.candidates.map((candidate) => ({
        id: candidate.id,
        summary: candidate.summary,
      }))
    );
  }
  if (details.kind === "llm-request") {
    return safeStringify(details.messages);
  }
  if (details.kind === "llm-response") {
    return details.content ?? "";
  }
  if (details.kind === "llm-response-raw") {
    return details.content ?? "";
  }
  if (details.kind === "llm-response-parsed") {
    return safeStringify(details.parsed);
  }
  if (details.kind === "llm-error") {
    return safeStringify({
      error: details.error,
      name: details.name,
      stack: details.stack,
      cause: details.cause,
      causeDetails: details.causeDetails,
      causeChain: details.causeChain,
      url: details.url,
      params: details.params,
      responseBody: details.responseBody,
    });
  }
  if (details.kind === "game-intent") {
    return safeStringify({
      intentType: details.intentType,
      label: details.label,
      actionId: details.actionId,
      fromPileId: details.fromPileId,
      toPileId: details.toPileId,
    });
  }
  return fallbackMessage;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? "", null, 2);
  } catch {
    return String(value ?? "");
  }
}

function toCompactJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function formatTimestampWithMs(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const base = date.toLocaleTimeString();
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${base}.${ms}`;
}
