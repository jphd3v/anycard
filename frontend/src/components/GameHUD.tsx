import { useMemo, useEffect, useState, useCallback, useRef } from "react";
import { useAtom, useAtomValue } from "jotai";
import {
  availableGamesAtom,
  rulesIdAtom,
  gameViewAtom,
  aiLogAtom,
  aiHistoricalUnavailableAtom,
  gameLogAtom,
  allSeatsAutomatedAtom,
  soundEnabledAtom,
  isMenuOpenAtom,
} from "../state";
import type { AiLogEntry } from "../state";

import { resetGameWithSeed, setGodMode } from "../socket";
import { ConfirmationOverlay } from "./ConfirmationOverlay";
import { useAiLog } from "../hooks/useAiLog";
import { useToast } from "../hooks/useToast";
import { sfx } from "../utils/audio";
import { copyToClipboard } from "../utils/clipboard";
import { ScrollShadowWrapper } from "./ScrollShadowWrapper";
import { GameMenu } from "./GameMenu";
import { safeStartViewTransition } from "../utils/viewTransition";
import { Overlay } from "./Overlay";

interface GameHUDProps {
  gameId: string;
  onExit: () => void;
  onReset: () => void;
  onAboutClick?: () => void;
  // Deprecated/Unused props kept for compatibility if needed, or removed if App.tsx is updated
  // We will update App.tsx to remove these
  identityLabel: string;
}

type ConfirmType = "restartHand" | "exit" | "restartSeed" | null;
type RenderLogEntry =
  | {
      source: "game";
      order: number;
      message: string;
      actorId: string | null;
      timestamp?: string;
      kind?: string;
      imported?: boolean;
    }
  | {
      source: "ai";
      order: number;
      entry: AiLogEntry;
    };

export function GameHUD({
  gameId,
  onExit,
  onReset,
  onAboutClick,
  identityLabel,
}: GameHUDProps) {
  const view = useAtomValue(gameViewAtom);
  const rulesId = useAtomValue(rulesIdAtom);
  const availableGames = useAtomValue(availableGamesAtom);
  const { isAiLogVisible, setAiLogVisible, refreshGameLog } = useAiLog();
  const aiLog = useAtomValue(aiLogAtom);
  const aiHistoricalUnavailable = useAtomValue(aiHistoricalUnavailableAtom);
  const gameLog = useAtomValue(gameLogAtom);
  const allSeatsAutomated = useAtomValue(allSeatsAutomatedAtom);
  const soundEnabled = useAtomValue(soundEnabledAtom);
  const [, setIsMenuOpen] = useAtom(isMenuOpenAtom);
  const { showToast } = useToast();

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
  const [showAiEvents, setShowAiEvents] = useState(false);

  const currentGameType = view?.rulesId ?? rulesId ?? "";
  const displayName =
    availableGames?.find((g) => g.id === currentGameType)?.name ??
    currentGameType ??
    "Game";

  const seed =
    (view?.metadata && typeof view.metadata.seed === "string"
      ? view.metadata.seed
      : null) || "Unknown";
  const savePersistedAt =
    typeof view?.metadata?.savePersistedAt === "string"
      ? view.metadata.savePersistedAt
      : null;
  const saveHydratedAt =
    typeof view?.metadata?.saveHydratedAt === "string"
      ? view.metadata.saveHydratedAt
      : null;
  const savePersistedAtLabel = (() => {
    if (!savePersistedAt) return null;
    const parsed = new Date(savePersistedAt);
    if (!Number.isFinite(parsed.getTime())) return null;
    return parsed.toLocaleTimeString([], {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  })();
  const saveHydratedAtLabel = (() => {
    if (!saveHydratedAt) return null;
    const parsed = new Date(saveHydratedAt);
    if (!Number.isFinite(parsed.getTime())) return null;
    return parsed.toLocaleTimeString([], {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  })();
  const isSpectator = view?.metadata?.role === "spectator";
  const isGodMode = view?.metadata?.isGodMode === "true";
  const roomCloseDelayMinutes = 5;
  const exitNotice = allSeatsAutomated
    ? "AI-only rooms close immediately once the last human leaves."
    : `Rooms close after ${roomCloseDelayMinutes} minutes once all human players have left.`;

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
    safeStartViewTransition(() => setIsMenuOpen(false));
  };

  const { groupedByTurn, renderedEntryCount } = useMemo(() => {
    const groups = new Map<
      number,
      { playerId: string | null; entries: RenderLogEntry[] }
    >();

    const pushEntry = (
      turnNumber: number,
      playerId: string | null,
      entry: RenderLogEntry
    ) => {
      const existing = groups.get(turnNumber);
      if (!existing) {
        groups.set(turnNumber, { playerId, entries: [entry] });
        return;
      }
      if (!existing.playerId && playerId) {
        existing.playerId = playerId;
      }
      existing.entries.push(entry);
    };

    for (const entry of gameLog) {
      pushEntry(entry.turnNumber, entry.actorId ?? null, {
        source: "game",
        order: entry.index * 10,
        message: entry.message,
        actorId: entry.actorId ?? null,
        timestamp: entry.timestamp,
        kind: entry.kind,
        imported: entry.imported,
      });
    }

    if (showAiEvents) {
      for (const entry of aiLog.filter(shouldRenderAiLogEntry)) {
        const timestamp = new Date(entry.timestamp ?? 0).getTime();
        const normalizedOrder = Number.isFinite(timestamp)
          ? timestamp
          : Number.MAX_SAFE_INTEGER;
        pushEntry(entry.turnNumber ?? 0, entry.playerId ?? null, {
          source: "ai",
          order: normalizedOrder,
          entry,
        });
      }
    }

    const grouped = Array.from(groups.entries())
      .sort(([left], [right]) => left - right)
      .map(([turnNumber, value]) => ({
        turnNumber,
        playerId: value.playerId,
        entries: value.entries.sort((left, right) => {
          if (left.order !== right.order) {
            return left.order - right.order;
          }
          if (left.source === right.source) return 0;
          return left.source === "game" ? -1 : 1;
        }),
      }));

    const renderedCount = grouped.reduce(
      (count, group) => count + group.entries.length,
      0
    );
    return { groupedByTurn: grouped, renderedEntryCount: renderedCount };
  }, [aiLog, gameLog, showAiEvents]);

  useEffect(() => {
    if (!isAiLogVisible) return;
    void refreshGameLog();
  }, [
    isAiLogVisible,
    refreshGameLog,
    view?.stateVersion,
    view?.lastAction?.id,
  ]);

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
  }, [isAiLogVisible, renderedEntryCount]);

  const handleToggleGodMode = () => {
    if (!gameId) return;
    setGodMode(gameId, !isGodMode);
  };

  // Close on Escape for AI Log
  useEffect(() => {
    if (!isAiLogVisible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAiLogVisible(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isAiLogVisible, setAiLogVisible]);

  return (
    <>
      <GameMenu
        gameId={gameId}
        seed={seed}
        onResetSeed={handleResetSeed}
        isSpectator={isSpectator}
        isGodMode={isGodMode}
        onToggleGodMode={handleToggleGodMode}
        onRestartHand={() => setConfirmType("restartHand")}
        onExit={() => setConfirmType("exit")}
        onAbout={() => {
          safeStartViewTransition(() => setIsMenuOpen(false));
          onAboutClick?.();
        }}
        displayName={displayName}
        isBlocked={!!confirmType || isAiLogVisible}
      />

      {confirmType === "restartSeed" && (
        <ConfirmationOverlay
          title="Restart with a new shuffle seed?"
          description="This resets the current hand and deals a fresh shuffle."
          confirmLabel="Restart"
          onConfirm={confirmResetSeed}
          onCancel={() => {
            setConfirmType(null);
            setPendingSeed(null);
          }}
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
            safeStartViewTransition(() => setIsMenuOpen(false));
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

      {/* --- Game Log Modal --- */}
      {isAiLogVisible && (
        <Overlay
          className="items-center justify-center p-0 lg:p-8 xl:p-12"
          onClick={() => setAiLogVisible(false)}
        >
          <div
            className="ai-log-modal w-full h-full max-w-none overflow-hidden rounded-none bg-surface-1 border-0 shadow-xl flex flex-col lg:max-h-[820px] lg:max-w-[1280px] lg:rounded-xl lg:border lg:border-surface-3"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Game Log"
            style={{ viewTransitionName: "ai-log-content" }}
          >
            <div className="px-4 py-3 border-b border-surface-3 flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="ai-log-title text-sm font-bold text-indigo-600 uppercase tracking-wide">
                      Game log
                    </span>
                    <div className="flex gap-1.5 flex-wrap">
                      <div className="flex items-center gap-1">
                        <span className="ai-log-meta-label text-2xs text-ink-muted uppercase font-bold">
                          Game
                        </span>
                        <span className="ai-log-meta-value font-mono text-xs text-ink bg-surface-2 px-1.5 py-0.5 rounded">
                          <span className="ai-log-meta-value font-sans text-xs text-ink">
                            {displayName}
                          </span>
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="ai-log-meta-label text-2xs text-ink-muted uppercase font-bold">
                          Room ID
                        </span>
                        <span className="ai-log-meta-value font-mono text-xs text-ink bg-surface-2 px-1.5 py-0.5 rounded">
                          {gameId}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="ai-log-meta-label text-2xs text-ink-muted uppercase font-bold">
                          Seed
                        </span>
                        <span className="ai-log-meta-value font-mono text-xs text-ink bg-surface-2 px-1.5 py-0.5 rounded">
                          {seed}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="ai-log-meta-label text-2xs text-ink-muted uppercase font-bold">
                          Player
                        </span>
                        <span className="ai-log-meta-value font-mono text-xs text-ink bg-surface-2 px-1.5 py-0.5 rounded">
                          {identityLabel}
                        </span>
                      </div>
                      {saveHydratedAtLabel && (
                        <div className="flex items-center gap-1">
                          <span className="ai-log-meta-label text-2xs text-ink-muted uppercase font-bold">
                            Restored At
                          </span>
                          <span className="ai-log-meta-value font-mono text-xs text-ink bg-surface-2 px-1.5 py-0.5 rounded">
                            {saveHydratedAtLabel}
                          </span>
                        </div>
                      )}
                      {savePersistedAtLabel && (
                        <div className="flex items-center gap-1">
                          <span className="ai-log-meta-label text-2xs text-ink-muted uppercase font-bold">
                            Saved At
                          </span>
                          <span className="ai-log-meta-value font-mono text-xs text-ink bg-surface-2 px-1.5 py-0.5 rounded">
                            {savePersistedAtLabel}
                          </span>
                        </div>
                      )}
                      <label className="flex items-center gap-2 pl-2">
                        <input
                          type="checkbox"
                          checked={showAiEvents}
                          onChange={(event) =>
                            setShowAiEvents(event.target.checked)
                          }
                          className="h-3.5 w-3.5 rounded border border-surface-4"
                        />
                        <span className="text-2xs text-ink-muted uppercase font-bold tracking-wide">
                          Show AI events
                        </span>
                      </label>
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
                    if (showAiEvents) {
                      logContent += "AI events: included\n\n";
                    }

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
                        if (entry.source === "game") {
                          if (entry.timestamp) {
                            const time = formatTimestampWithMs(entry.timestamp);
                            logContent += `${time} ${entry.message}\n`;
                          } else {
                            const prefix = entry.kind
                              ? `[${entry.kind}] `
                              : "[event] ";
                            logContent += `${prefix}${entry.message}\n`;
                          }
                          continue;
                        }

                        const aiEntry = entry.entry;
                        const time = formatTimestampWithMs(
                          aiEntry.timestamp ?? ""
                        );
                        const details = parseAiLogDetails(aiEntry.details);
                        logContent += `${time} ${details ? formatAiLogDetailsForCopy(details, aiEntry.message) : aiEntry.message}\n`;
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
                  className="p-2 -mr-2 text-ink-muted hover:text-ink hover:bg-surface-2 rounded-full transition-colors flex-shrink-0"
                  onClick={() => setAiLogVisible(false)}
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
            </div>
            <ScrollShadowWrapper
              className="ai-log-body flex-1 text-xs font-mono bg-surface-2/80"
              scrollRef={aiLogScrollRef}
              onScroll={handleAiLogScroll}
            >
              <div className="px-4 py-3 w-fit min-w-full">
                {showAiEvents &&
                  aiHistoricalUnavailable &&
                  aiLog.length === 0 && (
                    <div className="mb-3 rounded border border-surface-3 bg-surface-1 px-3 py-2 text-[11px] text-ink-muted">
                      Historical AI telemetry is unavailable for this session.
                      New AI events will appear as play continues.
                    </div>
                  )}
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
                              if (entry.source === "game") {
                                return (
                                  <li
                                    key={`${entry.source}-${entry.order}-${idx}`}
                                    className="grid grid-cols-[20px_92px_92px_minmax(0,1fr)] lg:grid-cols-[22px_124px_92px_minmax(0,1fr)] gap-x-2 lg:gap-x-3 gap-y-0.5 items-start"
                                  >
                                    <button
                                      type="button"
                                      className="button-base button-ghost text-ink-muted hover:text-ink h-5 w-5 p-0 self-start"
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        handleCopy(
                                          entry.message,
                                          "Game log entry"
                                        );
                                      }}
                                      aria-label="Copy game log entry"
                                    >
                                      📋
                                    </button>
                                    <span className="text-ink-muted tabular-nums leading-5">
                                      {formatGameLogTimestamp(entry.timestamp)}
                                    </span>
                                    <span className="text-[10px] leading-5 uppercase tracking-wide text-ink-muted/80 whitespace-nowrap">
                                      {(entry.kind ?? "event").toUpperCase()}
                                    </span>
                                    <div className="col-start-2 col-span-3 lg:col-auto lg:col-span-1 text-ink break-words leading-5 min-w-0">
                                      {entry.message}
                                      {entry.imported ? (
                                        <span className="ml-2 text-[10px] uppercase tracking-wide text-amber-700/90 align-middle whitespace-nowrap">
                                          Imported
                                        </span>
                                      ) : null}
                                    </div>
                                  </li>
                                );
                              }

                              const time = formatTimestampWithMs(
                                entry.entry.timestamp ?? ""
                              );
                              const details = parseAiLogDetails(
                                entry.entry.details
                              );

                              return (
                                <li
                                  key={`${entry.source}-${entry.entry.timestamp ?? idx}-${idx}`}
                                  className="grid grid-cols-[20px_92px_92px_minmax(0,1fr)] lg:grid-cols-[22px_124px_92px_minmax(0,1fr)] gap-x-2 lg:gap-x-3 gap-y-0.5 items-start"
                                >
                                  <button
                                    type="button"
                                    className="button-base button-ghost text-ink-muted hover:text-ink h-5 w-5 p-0 self-start"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      handleCopy(
                                        details
                                          ? getAiLogCopyPayload(
                                              details,
                                              entry.entry.message
                                            )
                                          : entry.entry.message,
                                        "Game log entry"
                                      );
                                    }}
                                    aria-label="Copy game log entry"
                                  >
                                    📋
                                  </button>
                                  <span className="text-ink-muted tabular-nums leading-5">
                                    {time}
                                  </span>
                                  <span className="text-[10px] leading-5 uppercase tracking-wide text-ink-muted/80 whitespace-nowrap">
                                    AI
                                  </span>
                                  <div className="col-start-2 col-span-3 lg:col-auto lg:col-span-1 text-ink break-words min-w-0">
                                    {details
                                      ? renderAiLogDetails(
                                          details,
                                          entry.entry.message
                                        )
                                      : entry.entry.message}
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
        </Overlay>
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

function shouldRenderAiLogEntry(entry: AiLogEntry): boolean {
  if (!isRenderableAiLogEntry(entry)) return false;
  const details = parseAiLogDetails(entry.details);
  // The deterministic game log already includes canonical executed actions and
  // moves. Hide mirrored AI telemetry `game-intent` rows to avoid duplicates.
  if (details?.kind === "game-intent") {
    return false;
  }
  return true;
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
    )}
`;
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

function formatGameLogTimestamp(timestamp?: string): string {
  if (!timestamp) return "--:--:--.---";
  return formatTimestampWithMs(timestamp);
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
