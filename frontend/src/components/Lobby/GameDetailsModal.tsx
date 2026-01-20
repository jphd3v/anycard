import { useEffect, useRef, useState, useMemo } from "react";
import { SERVER_URL } from "../../socket";
import { Overlay } from "../Overlay";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { ScrollShadowWrapper } from "../ScrollShadowWrapper";
import type {
  AvailableGame,
  ActiveGameSummary,
  RecentGameEntry,
} from "../../state";

interface Props {
  game: AvailableGame;
  activeGames: ActiveGameSummary[];
  recentGames: RecentGameEntry[];
  onClose: () => void;
  onStart: (rulesId: string, seed?: string) => void;
  onStartPublic: (rulesId: string, seed?: string) => void;
  onJoin: (rulesId: string, gameId: string) => void;
}

export function GameDetailsModal({
  game,
  activeGames,
  recentGames,
  onClose,
  onStart,
  onStartPublic,
  onJoin,
}: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<"play" | "rules">("play");
  const [rulesText, setRulesText] = useState<string | null>(null);
  const [loadingRules, setLoadingRules] = useState(false);
  const [manualGameId, setManualGameId] = useState("");
  const [customSeed, setCustomSeed] = useState("");
  const [privateRoomStatuses, setPrivateRoomStatuses] = useState<
    Record<
      string,
      { status: string; numOccupiedSeats?: number; numSeats?: number } | null
    >
  >({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const titleId = `game-details-title-${game.id}`;

  // Filter active games for this type
  const gamesOfThisType = useMemo(
    () => activeGames.filter((g) => g.rulesId === game.id),
    [activeGames, game.id]
  );
  const recentRooms = useMemo(
    () =>
      recentGames
        .filter((g) => g.rulesId === game.id && g.roomType === "private")
        .sort((a, b) => b.lastJoinedAt - a.lastJoinedAt),
    [recentGames, game.id]
  );
  const activeById = useMemo(
    () => new Map(gamesOfThisType.map((active) => [active.gameId, active])),
    [gamesOfThisType]
  );

  useEffect(() => {
    const fetchStatuses = async () => {
      if (document.hidden) return;
      // identify private rooms that we don't have status for (or are potentially stale?)
      // For now, just fetch for all displayed private rooms to ensure freshness on open
      const roomsToCheck = recentRooms.filter(
        (room) => !activeById.has(room.gameId)
      );

      if (roomsToCheck.length === 0) return;

      const results: Record<
        string,
        { status: string; numOccupiedSeats?: number; numSeats?: number } | null
      > = {};
      await Promise.all(
        roomsToCheck.map(async (room) => {
          try {
            const res = await fetch(
              `${SERVER_URL}/active-games/${room.gameId}`
            );
            if (res.ok) {
              const data = await res.json();
              if (data.ok && data.game) {
                const s = data.game.status;
                results[room.gameId] = {
                  status:
                    s === "waiting"
                      ? "Waiting"
                      : s === "playing"
                        ? "In Progress"
                        : s === "finished"
                          ? "Finished"
                          : "Unknown",
                  numOccupiedSeats: data.game.numOccupiedSeats,
                  numSeats: data.game.numSeats,
                };
              } else {
                results[room.gameId] = { status: "Game closed" }; // Likely finished/cleaned up
              }
            } else {
              results[room.gameId] = { status: "Game closed" };
            }
          } catch {
            results[room.gameId] = { status: "Error" };
          }
        })
      );
      setPrivateRoomStatuses((prev) => ({ ...prev, ...results }));
    };

    fetchStatuses();
    const intervalId = setInterval(fetchStatuses, 5000);

    return () => clearInterval(intervalId);
  }, [game.id, recentRooms, activeById]);

  // Prepare unified list
  // 1. Private rooms (known by user, not currently in active list)
  const privateRooms = recentRooms
    .filter((room) => !activeById.has(room.gameId))
    .map((room) => {
      const info = privateRoomStatuses[room.gameId];
      const status = info?.status || "Checking...";
      const isClosed = status === "Game closed";
      const countText =
        info?.numOccupiedSeats !== undefined && info?.numSeats !== undefined
          ? ` • ${info.numOccupiedSeats} / ${info.numSeats} Players`
          : "";

      return {
        type: "private" as const,
        id: room.gameId,
        details: isClosed ? (
          <span className="line-through opacity-60">Game closed</span>
        ) : (
          `${status}${countText}`
        ),
        spectators: "",
        badge: "Private Room",
        badgeClass: "text-slate-700 bg-slate-100",
        sortKey: 0,
      };
    });

  // 2. Active Public Rooms
  const publicRooms = gamesOfThisType
    .filter((g) => g.roomType === "public")
    .map((g) => {
      const status =
        g.status === "waiting"
          ? "Waiting"
          : g.status === "playing"
            ? "In Progress"
            : g.status === "finished"
              ? "Finished"
              : "Unknown";
      return {
        type: "public" as const,
        id: g.gameId,
        details: `${status} • ${g.numOccupiedSeats} / ${g.numSeats} Players`,
        spectators:
          g.numSpectators > 0
            ? ` • ${g.numSpectators} Spectator${
                g.numSpectators === 1 ? "" : "s"
              }`
            : "",
        badge: "Public Room",
        badgeClass: "text-emerald-700 bg-emerald-100",
        sortKey: 1,
      };
    });

  // 3. Demo Rooms
  const demoRooms = gamesOfThisType
    .filter((g) => g.roomType === "demo")
    .map((g) => {
      const status =
        g.status === "waiting"
          ? "Waiting"
          : g.status === "playing"
            ? "In Progress"
            : g.status === "finished"
              ? "Finished"
              : "Unknown";
      return {
        type: "demo" as const,
        id: g.gameId,
        details: `${status} • ${g.numOccupiedSeats} / ${g.numSeats} Players`,
        spectators:
          g.numSpectators > 0
            ? ` • ${g.numSpectators} Spectator${
                g.numSpectators === 1 ? "" : "s"
              }`
            : "",
        badge: "Public Always-On Demo",
        badgeClass: "text-amber-700 bg-amber-100",
        sortKey: 2,
      };
    });

  const allRooms = [...privateRooms, ...publicRooms, ...demoRooms];
  const trimmedManualGameId = manualGameId.trim();
  const canJoinManual = trimmedManualGameId.length > 0;

  useEffect(() => {
    if (activeTab === "rules" && !rulesText) {
      setLoadingRules(true);
      fetch(`${SERVER_URL}/rules/${game.id}/${game.id}.rules.md`)
        .then((res) => {
          if (!res.ok) throw new Error("No rules found");
          return res.text();
        })
        .then((text) => setRulesText(text))
        .catch(() => setRulesText("Rules not available for this game."))
        .finally(() => setLoadingRules(false));
    }
  }, [activeTab, game.id, rulesText]);

  useEffect(() => {
    const container = modalRef.current;
    if (!container) return;
    const focusable = container.querySelectorAll<HTMLElement>(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
    );
    const first = focusable[0];
    if (first) {
      first.focus();
    } else {
      container.focus();
    }
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }

    if (event.key !== "Tab") return;
    const container = modalRef.current;
    if (!container) return;

    const focusable = Array.from(
      container.querySelectorAll<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
      )
    ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);

    if (focusable.length === 0) {
      event.preventDefault();
      container.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    }
  };

  return (
    <Overlay
      translucent
      blurred
      className="items-center landscape:items-start justify-center p-4 sm:p-6 landscape:pt-8 landscape:overflow-y-auto"
      onClick={onClose}
    >
      {/* Modal Content */}
      <div
        className="relative w-full max-w-[640px] landscape:max-w-4xl bg-surface-1 rounded-2xl shadow-floating flex flex-col max-h-[90vh] landscape:max-h-none sm:max-h-[800px] animate-in fade-in zoom-in-95 duration-300 overflow-hidden landscape:mb-8"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
        ref={modalRef}
      >
        {/* Header */}
        <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-surface-2 flex items-center justify-between bg-surface-1/50 backdrop-blur-md rounded-t-2xl sticky top-0 z-10">
          <div className="flex items-baseline gap-2 overflow-hidden mr-2">
            <h2
              id={titleId}
              className="text-lg sm:text-xl md:text-2xl font-serif-display font-bold text-ink whitespace-nowrap"
            >
              {game.name}
            </h2>
            <div className="flex items-center gap-2 flex-wrap">
              {gamesOfThisType.length > 0 && (
                <span className="text-2xs font-sans font-bold text-ink-muted uppercase tracking-wider bg-surface-2 px-2 py-0.5 rounded-full whitespace-nowrap">
                  {gamesOfThisType.length} Active{" "}
                  {gamesOfThisType.length === 1 ? "Room" : "Rooms"}
                </span>
              )}
              <span className="text-2xs font-mono text-ink-muted opacity-40 uppercase tracking-widest whitespace-nowrap">
                #{game.id}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 -mr-2 text-ink-muted hover:text-ink hover:bg-surface-2 rounded-full transition-colors relative z-20"
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
        {/* Tabs */}
        <div className="flex border-b border-surface-2 px-4 sm:px-6 relative z-10 shrink-0">
          <button
            onClick={() => setActiveTab("play")}
            className={`py-3 mr-6 text-xs sm:text-sm font-bold border-b-2 transition-colors ${
              activeTab === "play"
                ? "border-primary text-primary"
                : "border-transparent text-ink-muted hover:text-ink"
            }`}
          >
            Play
          </button>
          <button
            onClick={() => setActiveTab("rules")}
            className={`py-3 text-xs sm:text-sm font-bold border-b-2 transition-colors ${
              activeTab === "rules"
                ? "border-primary text-primary"
                : "border-transparent text-ink-muted hover:text-ink"
            }`}
          >
            Rules
          </button>
        </div>
        {/* Content Area */}
        <ScrollShadowWrapper
          className="flex-1 relative z-10 min-h-0"
          innerClassName="scrollbar-hide"
        >
          <div className="p-4 sm:p-6 w-fit min-w-full">
            {activeTab === "play" && (
              <div className="space-y-6">
                {/* Join by Room ID */}
                <div className="space-y-2">
                  <h3 className="text-2xs sm:text-xs font-bold text-ink-muted uppercase tracking-wider">
                    Join by Room ID
                  </h3>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      value={manualGameId}
                      onChange={(event) => setManualGameId(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && canJoinManual) {
                          onJoin(game.id, trimmedManualGameId);
                        }
                      }}
                      placeholder="Room ID"
                      className="flex-1 sm:flex-none sm:w-48 rounded-lg border border-surface-3 bg-surface-1 px-3 py-2 text-xs sm:text-sm text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none"
                    />
                    <button
                      onClick={() => onJoin(game.id, trimmedManualGameId)}
                      disabled={!canJoinManual}
                      className="button-base button-secondary px-4 py-2 text-xs sm:text-sm font-bold disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      Join Room
                    </button>
                  </div>
                </div>

                {/* Unified Room List */}
                <div className="mt-6">
                  <h3 className="text-2xs sm:text-xs font-bold text-ink-muted uppercase tracking-wider mb-3">
                    Available Rooms
                  </h3>
                  {allRooms.length > 0 ? (
                    <div className="space-y-2">
                      {allRooms.map((room) => (
                        <div
                          key={`${room.type}-${room.id}`}
                          className="flex items-center justify-between p-2 sm:p-3 rounded-lg bg-surface-2 border border-surface-3"
                        >
                          <div className="flex flex-col min-w-0 pr-2">
                            <span className="font-mono text-2xs text-ink-muted">
                              Room {room.id}
                            </span>
                            <span className="text-xs sm:text-sm">
                              {room.details}
                              {room.spectators}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span
                              className={`text-2xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${room.badgeClass}`}
                            >
                              {room.badge}
                            </span>
                            <button
                              onClick={() => onJoin(game.id, room.id)}
                              className="button-base button-secondary px-3 py-1.5 text-xs"
                            >
                              Join
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-6 text-ink-muted text-xs sm:text-sm border-2 border-dashed border-surface-2 rounded-xl">
                      No rooms are currently running for {game.name}.<br />
                      Start one below!
                    </div>
                  )}
                </div>

                {/* Main Actions */}
                <div className="pt-6 border-t border-surface-2 mt-6">
                  <div className="flex items-center justify-end mb-3">
                    <button
                      onClick={() => setShowAdvanced(!showAdvanced)}
                      className="text-2xs font-bold text-primary hover:text-primary-dark transition-colors uppercase tracking-widest flex items-center gap-1"
                    >
                      {showAdvanced ? "Hide Advanced" : "Advanced"}
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className={`w-3 h-3 transition-transform ${
                          showAdvanced ? "rotate-180" : ""
                        }`}
                      >
                        <path
                          fillRule="evenodd"
                          d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>
                  </div>

                  {showAdvanced && (
                    <div className="mb-4 p-3 bg-surface-2 rounded-xl border border-surface-3 animate-in fade-in slide-in-from-top-2 duration-200">
                      <label className="block text-2xs font-bold text-ink-muted uppercase tracking-wider mb-1.5 ml-1">
                        Shuffle Seed (Optional)
                      </label>
                      <input
                        value={customSeed}
                        onChange={(e) => setCustomSeed(e.target.value)}
                        placeholder="e.g. ABCDEF (Leave blank for random)"
                        className="w-full rounded-lg border border-surface-3 bg-surface-1 px-3 py-2 text-2xs font-mono text-ink placeholder:text-ink-muted/50 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/20"
                      />
                      <p className="mt-2 text-2xs text-ink-muted/70 leading-relaxed px-1">
                        Use a specific seed to replay a exact card distribution.
                        You can find seeds in the in-game menu of existing
                        matches.
                      </p>
                    </div>
                  )}

                  <div className="flex gap-3 justify-center sm:justify-start">
                    <button
                      onClick={() =>
                        onStart(game.id, customSeed.trim() || undefined)
                      }
                      className="button-base button-primary py-2.5 px-6 text-xs sm:text-sm font-bold w-fit shadow-lg hover:scale-[1.02]"
                    >
                      Start Private Room
                    </button>

                    <button
                      onClick={() =>
                        onStartPublic(game.id, customSeed.trim() || undefined)
                      }
                      className="button-base button-secondary py-2.5 px-6 text-xs sm:text-sm font-bold w-fit shadow-sm hover:scale-[1.01]"
                    >
                      Start Public Room
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "rules" && (
              <div className="prose prose-sm prose-invert max-w-none text-ink">
                {loadingRules ? (
                  <div className="py-12 flex justify-center">
                    <div className="spinner h-6 w-6 border-2" />
                  </div>
                ) : rulesText ? (
                  <MarkdownRenderer content={rulesText} />
                ) : (
                  <div className="text-center py-8 text-ink-muted text-sm border-2 border-dashed border-surface-2 rounded-xl">
                    No rules text loaded.
                  </div>
                )}
              </div>
            )}
          </div>
        </ScrollShadowWrapper>
        {/* Footer in Modal */}{" "}
        <div className="p-4 border-t border-surface-2 bg-surface-1/50 flex flex-col items-center relative z-10">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-2xs sm:text-xs font-bold uppercase tracking-widest text-ink-muted hover:text-ink hover:bg-surface-2 transition-all cursor-pointer rounded-lg border border-transparent hover:border-surface-3 active:scale-95 active:bg-surface-3/50 underline underline-offset-4 decoration-dotted"
          >
            Return to Home
          </button>
        </div>
      </div>
    </Overlay>
  );
}
