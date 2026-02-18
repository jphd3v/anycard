import type { AiRuntimePreference } from "../../state";
import type { SeatStatus } from "../../../../shared/schemas";
import { FullScreenMessage } from "../FullScreenMessage";

type RoomLobbyOverlayProps = {
  title: string;
  gameId: string;
  lobbySeed: string | null;
  roomTypeLabel: string | null;
  saveStorage: "supabase" | null;
  savePersistedAt: string | null;
  saveHydratedFrom: "supabase" | null;
  isCreator: boolean;
  isGameActive: boolean;
  allSeatsJoined: boolean;
  isSpectator: boolean;
  isGodMode: boolean;
  playerId: string | null;
  seats: SeatStatus[];
  joinAsGodMode: boolean;
  effectiveAiPreference: AiRuntimePreference;
  currentSeatLabel: string;
  onToggleGodMode: () => void;
  onJoinSeat: (seatId: string) => void;
  onJoinSpectator: (useGodMode: boolean) => void;
  onLeaveSeat: () => void;
  onApplyAiSetting: (seatId: string, enable: boolean) => void;
  onExitToSelection: () => void;
  onShare: () => void;
};

export function RoomLobbyOverlay({
  title,
  gameId,
  lobbySeed,
  roomTypeLabel,
  saveStorage,
  savePersistedAt,
  saveHydratedFrom,
  isCreator,
  isGameActive,
  allSeatsJoined,
  isSpectator,
  isGodMode,
  playerId,
  seats,
  joinAsGodMode,
  effectiveAiPreference,
  currentSeatLabel,
  onToggleGodMode,
  onJoinSeat,
  onJoinSpectator,
  onLeaveSeat,
  onApplyAiSetting,
  onExitToSelection,
  onShare,
}: RoomLobbyOverlayProps) {
  const seatsFilledCount = seats.filter((seat) => {
    const runtime = seat.aiRuntime ?? (seat.isAi ? "backend" : "none");
    return seat.occupied || runtime !== "none";
  }).length;

  const formatIsoTime = (iso: string | null): string | null => {
    if (!iso) return null;
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toLocaleTimeString([], {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };
  const savePersistedTime = formatIsoTime(savePersistedAt);

  return (
    <FullScreenMessage
      title={title}
      overlayClassName="items-stretch justify-stretch !p-0 xl:items-center xl:justify-center xl:!p-6 !overflow-hidden"
      panelClassName={`seat-selection-panel !max-w-none xl:!max-w-[640px] !h-full xl:!h-auto !min-h-0 !rounded-none xl:!rounded-2xl !p-0 !mb-0 !border-0 xl:!border xl:!max-h-[90vh] !overflow-y-auto ${!isGameActive ? "!bg-surface-1" : ""}`}
      titleClassName="!text-center !font-serif-display !text-lg sm:!text-xl md:!text-2xl !py-4 sm:!py-5 !px-4 border-b border-surface-2 bg-surface-1/50 backdrop-blur-md relative z-10 !mb-0 !rounded-none xl:!rounded-t-2xl"
      descriptionClassName="!text-ink !p-4 sm:!p-6 !mb-0"
      translucent={isGameActive}
      canMinimize={isGameActive && !allSeatsJoined}
      onClose={onExitToSelection}
      showBackArrow={true}
      description={
        <div
          className="seat-selection-body flex flex-col w-full mx-auto text-xs sm:text-sm"
          style={{
            gap: "clamp(12px, 3vw, 20px)",
          }}
        >
          {effectiveAiPreference === "off" && (
            <div className="text-2xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 text-center">
              AI runtime is Off. Enable it from the Home Config to toggle AI
              seats.
            </div>
          )}

          {seats.some((seat) => seat.aiRuntime === "frontend") && (
            <div className="text-2xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 text-center">
              Warning: Frontend AI runs in a browser and can see hidden info.
            </div>
          )}

          <div className="flex flex-col gap-1.5 items-center my-1">
            <div className="flex gap-2 items-center">
              <span
                className={`px-2 py-0.5 rounded text-2xs font-bold uppercase tracking-wider ${
                  isCreator
                    ? "bg-green-100 text-green-700 border border-green-200"
                    : "bg-blue-100 text-blue-700 border border-blue-200"
                }`}
              >
                {isCreator
                  ? "Room Created"
                  : isGameActive
                    ? "Room Joined"
                    : "Room Found"}
              </span>

              {roomTypeLabel && (
                <span className="px-2 py-0.5 rounded text-2xs font-black uppercase tracking-tighter bg-primary/10 text-primary border border-primary/20">
                  {roomTypeLabel}
                </span>
              )}

              <div className="flex items-center gap-1">
                <span className="text-xs font-mono text-ink-muted bg-surface-2 px-2 py-0.5 rounded border border-surface-3">
                  ID: {gameId}
                </span>
                <button
                  type="button"
                  onClick={onShare}
                  className="button-base button-icon button-secondary h-6 w-6 flex items-center justify-center"
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

              {saveStorage && (
                <span className="px-2 py-0.5 rounded text-2xs font-bold uppercase tracking-wider bg-emerald-100 text-emerald-700 border border-emerald-200">
                  Saved
                </span>
              )}

              {saveHydratedFrom && (
                <span className="px-2 py-0.5 rounded text-2xs font-bold uppercase tracking-wider bg-amber-100 text-amber-700 border border-amber-200">
                  Restored
                </span>
              )}
            </div>

            {lobbySeed && (
              <div className="text-2xs text-ink-muted/70 font-mono italic">
                Seed: {lobbySeed}
              </div>
            )}

            {savePersistedTime && (
              <div className="text-2xs text-ink-muted/70 font-mono italic">
                Last save: {savePersistedTime}
              </div>
            )}
          </div>

          <div className="flex flex-col items-center gap-2">
            {isGameActive ? (
              <div className="flex flex-col items-center gap-2">
                {isSpectator ? (
                  <div className="text-sm sm:text-base font-medium flex items-center justify-center flex-wrap gap-x-1 gap-y-1">
                    <span>
                      You are watching as a{" "}
                      <span className="text-primary font-bold">
                        spectator
                        {isGodMode && (
                          <span className="ml-1 opacity-60 font-normal">
                            (God mode)
                          </span>
                        )}
                      </span>
                    </span>
                    <button
                      onClick={onLeaveSeat}
                      className="px-1.5 py-0.5 text-2xs font-bold uppercase tracking-wider text-red-600/80 hover:text-red-600 hover:bg-red-50 transition-all cursor-pointer rounded underline underline-offset-2 decoration-dotted active:scale-95"
                    >
                      (leave)
                    </button>
                  </div>
                ) : (
                  <div className="text-sm sm:text-base font-medium flex items-center justify-center flex-wrap gap-x-1 gap-y-1">
                    <span>
                      You have taken a seat:{" "}
                      <span className="text-primary font-bold">
                        {currentSeatLabel}
                      </span>
                    </span>
                    <button
                      onClick={onLeaveSeat}
                      className="px-1.5 py-0.5 text-2xs font-bold uppercase tracking-wider text-red-600/80 hover:text-red-600 hover:bg-red-50 transition-all cursor-pointer rounded underline underline-offset-2 decoration-dotted active:scale-95"
                    >
                      (leave)
                    </button>
                  </div>
                )}
                <p className="text-xs sm:text-sm text-ink-muted text-center">
                  Waiting for other players to join the room before the game can
                  begin.
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <div className="text-sm sm:text-base font-medium text-center">
                  Choose a seat to join this room.
                </div>
                <p className="text-xs sm:text-sm text-ink-muted text-center">
                  You can also watch as a spectator if you just want to observe.
                </p>
              </div>
            )}
          </div>

          {seats.length > 0 && (
            <div className="flex flex-col gap-1.5 items-center w-full max-w-xs">
              <div className="text-xs font-bold uppercase tracking-widest text-ink-muted">
                Seats filled: {seatsFilledCount} / {seats.length}
              </div>
            </div>
          )}

          {seats.length === 0 ? (
            <div className="text-xs text-ink-muted text-center">
              Loading seats...
            </div>
          ) : (
            <div
              className="seat-selection-grid grid grid-cols-1 min-[440px]:grid-cols-2 w-full"
              style={{ gap: "clamp(10px, 3vw, 14px)" }}
            >
              {seats.map((seat) => {
                const aiRuntime =
                  seat.aiRuntime ?? (seat.isAi ? "backend" : "none");
                const isAiSeat = aiRuntime !== "none";
                const isBrowserAi = aiRuntime === "frontend";
                const isSeatMine = playerId === seat.playerId && !isSpectator;
                const isHumanOccupied = seat.occupied && !isAiSeat;
                const isHumanOccupiedByOther = isHumanOccupied && !isSeatMine;
                const isJoinLocked = isAiSeat || isHumanOccupied;
                const canEnableAiSeat = effectiveAiPreference !== "off";
                // Backend AI: Can't enable AI on your own seat
                // Frontend AI: Can enable AI on your own seat (sponsoring)
                const aiToggleDisabled =
                  (isSeatMine && effectiveAiPreference === "backend") ||
                  (!canEnableAiSeat && !isAiSeat);

                return (
                  <div
                    key={seat.playerId}
                    data-testid={`seat-card:${seat.playerId}`}
                    className={`

                            seat-selection-card relative w-full rounded-xl border-2 transition-all flex flex-col items-stretch

                            ${
                              isJoinLocked
                                ? "bg-surface-2 border-surface-3 opacity-80"
                                : "bg-surface-1 border-surface-3 hover:border-primary/30 hover:bg-surface-1/80"
                            }

                          `}
                    style={{
                      padding: "clamp(10px, 2.5vw, 16px)",
                      gap: "clamp(8px, 2vw, 12px)",
                    }}
                  >
                    <div className="w-full font-semibold text-xs sm:text-sm md:text-base text-ink flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-center">
                      <span className="truncate">
                        {seat.name ?? seat.playerId}
                      </span>

                      {isAiSeat && (
                        <span className="text-2xs text-indigo-600 font-medium bg-indigo-50 rounded px-1 py-0.5">
                          {isBrowserAi ? "AI (browser)" : "AI (server)"}
                        </span>
                      )}
                    </div>

                    {isJoinLocked ? (
                      <div
                        data-testid={`seat-state:${seat.playerId}`}
                        data-state={
                          playerId === seat.playerId ? "me" : "occupied"
                        }
                        className="w-full min-h-[36px] flex items-stretch"
                      >
                        <div className="w-full px-2 py-0.5 bg-surface-3 text-ink-muted text-2xs font-semibold uppercase tracking-wide rounded-full text-center flex items-center justify-center">
                          {isAiSeat
                            ? "AI Controlled"
                            : isSeatMine
                              ? "Your Seat"
                              : "Occupied"}
                        </div>
                      </div>
                    ) : (
                      <div
                        data-testid={`seat-state:${seat.playerId}`}
                        data-state="open"
                        className="w-full min-h-[36px] flex items-stretch"
                      >
                        <button
                          onClick={() => onJoinSeat(seat.playerId)}
                          data-testid={`seat-join:${seat.playerId}`}
                          className="button-base button-primary mx-auto w-fit px-6 h-full min-h-[36px] text-xs shadow-sm hover:shadow-md"
                        >
                          Join Game
                        </button>
                      </div>
                    )}

                    <div
                      className={`w-full flex items-center justify-between pt-1 sm:pt-1.5 border-t border-surface-3/50 ${
                        isHumanOccupiedByOther
                          ? "opacity-50 pointer-events-none"
                          : ""
                      }`}
                    >
                      <span className="text-2xs font-medium text-ink-muted">
                        AI Player
                      </span>

                      <button
                        type="button"
                        data-testid={`seat-ai-toggle:${seat.playerId}`}
                        disabled={aiToggleDisabled}
                        onClick={() =>
                          onApplyAiSetting(seat.playerId, !isAiSeat)
                        }
                        className={`

                                relative inline-flex h-4 w-8 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50

                                ${isAiSeat ? "bg-indigo-600" : "bg-surface-3"}

                                ${
                                  aiToggleDisabled
                                    ? "opacity-50 cursor-not-allowed"
                                    : "cursor-pointer"
                                }

                              `}
                      >
                        <span
                          className={`

                                  inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform

                                  ${isAiSeat ? "translate-x-4" : "translate-x-1"}

                                `}
                        />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {!isSpectator && (
            <div
              className="seat-selection-actions flex flex-col items-center w-full mt-2"
              style={{ gap: "clamp(12px, 3vw, 16px)" }}
            >
              <div className="w-full bg-surface-1 border-2 border-surface-3 rounded-xl p-3 flex flex-col sm:flex-row items-center justify-between gap-3 transition-all hover:border-primary/30 hover:bg-surface-1/80">
                <div className="flex items-center gap-2 order-2 sm:order-1">
                  <div
                    className="flex items-center gap-2 text-xs font-medium text-ink cursor-pointer select-none"
                    onClick={onToggleGodMode}
                  >
                    <button
                      type="button"
                      role="switch"
                      aria-checked={joinAsGodMode}
                      className={`

                              relative inline-flex h-4 w-8 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/50

                              ${joinAsGodMode ? "bg-blue-600" : "bg-surface-3"}

                            `}
                    >
                      <span
                        className={`

                                inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform

                                ${
                                  joinAsGodMode
                                    ? "translate-x-4"
                                    : "translate-x-1"
                                }

                              `}
                      />
                    </button>

                    <span>Enable God Mode</span>
                  </div>
                </div>

                <button
                  onClick={() => onJoinSpectator(joinAsGodMode)}
                  className="button-base button-secondary text-xs px-6 py-2 w-fit mx-auto sm:w-auto font-bold shadow-sm order-1 sm:order-2"
                >
                  Watch as Spectator
                </button>
              </div>
            </div>
          )}

          <button
            onClick={onExitToSelection}
            className="mt-2 px-3 py-1.5 text-2xs sm:text-xs font-bold uppercase tracking-widest text-ink-muted hover:text-ink hover:bg-surface-2 transition-all cursor-pointer rounded-lg border border-transparent hover:border-surface-3 active:scale-95 active:bg-surface-3/50 underline underline-offset-4 decoration-dotted"
          >
            Back to game selection
          </button>
        </div>
      }
    />
  );
}
