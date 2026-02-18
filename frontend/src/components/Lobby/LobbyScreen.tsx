import { useEffect, useState } from "react";
import type {
  ActiveGameSummary,
  AiRuntimePreference,
  AvailableGame,
  BackendRuntimeInfo,
  LocalAiConfig,
  RecentGameEntry,
  ThemeSetting,
} from "../../state";
import { AiSettings } from "./AiSettings";
import { JoinGameInput } from "./JoinGameInput";
import { LobbyFooter } from "./LobbyFooter";
import { GameListItem } from "./GameListItem";
import {
  BottomCornerOrnaments,
  SuitDivider,
  TopCornerOrnaments,
} from "./SuitDecorations";
import { WelcomeModal } from "../WelcomeModal";
import {
  INVALID_EMAIL_MESSAGE,
  INVALID_API_KEY_MESSAGE,
} from "../../auth/messages";

type LobbyScreenProps = {
  themeSetting: ThemeSetting;
  showSettings: boolean;
  onToggleSettings: () => void;
  onCycleTheme: () => void;
  aiRuntimePreference: AiRuntimePreference;
  onChangeAiRuntimePreference: (value: AiRuntimePreference) => void;
  localAiConfig: LocalAiConfig;
  onChangeLocalAiConfig: (value: LocalAiConfig) => void;
  serverAiEnabled: boolean;
  onJoinManual: (gameId: string, rulesId?: string) => void;
  onRefreshLobby: () => void;
  onGameSelect: (game: AvailableGame) => void;
  onAboutClick: () => void;
  isLobbyLoading: boolean;
  identityWarning?: string | null;
  identityMode: "guest" | "user";
  identityLabel: string;
  isIdentityAvailable: boolean;
  authEmail: string;
  authBusy: boolean;
  authMessage?: string | null;
  onAuthEmailChange: (value: string) => void;
  onSendMagicLink: () => void;
  onSignOut: () => void;
  availableGames: AvailableGame[];
  sortedAvailableGames: AvailableGame[];
  activeGames: ActiveGameSummary[];
  recentGames: RecentGameEntry[];
  backendRuntime: BackendRuntimeInfo | null;
};

export function LobbyScreen({
  themeSetting,
  showSettings,
  onToggleSettings,
  onCycleTheme,
  aiRuntimePreference,
  onChangeAiRuntimePreference,
  localAiConfig,
  onChangeLocalAiConfig,
  serverAiEnabled,
  onJoinManual,
  onRefreshLobby,
  onGameSelect,
  onAboutClick,
  isLobbyLoading,
  identityWarning,
  identityMode,
  identityLabel,
  isIdentityAvailable,
  authEmail,
  authBusy,
  authMessage,
  onAuthEmailChange,
  onSendMagicLink,
  onSignOut,
  availableGames,
  sortedAvailableGames,
  activeGames,
  recentGames,
  backendRuntime,
}: LobbyScreenProps) {
  const [showProfile, setShowProfile] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);

  useEffect(() => {
    const hasSeenWelcome = localStorage.getItem("anycard:welcome_seen");
    if (!hasSeenWelcome) {
      // Delay slightly to allow initial render
      const timer = setTimeout(() => setShowWelcome(true), 500);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleCloseWelcome = () => {
    localStorage.setItem("anycard:welcome_seen", "true");
    setShowWelcome(false);
  };

  const handleSignInClick = () => {
    setShowProfile(true);
  };

  return (
    <div className="flex-1 w-full flex flex-col max-w-lg landscape:max-w-none landscape:px-12 mx-auto h-full overflow-y-auto relative bg-surface-1 scrollbar-hide">
      {showWelcome && (
        <WelcomeModal
          onClose={handleCloseWelcome}
          onSignInClick={handleSignInClick}
        />
      )}

      <header className="relative pb-2 px-6 text-center z-10 shrink-0 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] md:pt-12">
        <TopCornerOrnaments />
        <h1 className="text-4xl md:text-5xl font-serif-display font-black text-ink mb-2 tracking-tight drop-shadow-sm relative z-10">
          AnyCard
        </h1>
        <p className="text-xs md:text-sm font-medium text-ink-muted uppercase tracking-[0.2em] opacity-80 relative z-10">
          Universal Card Game Engine
        </p>

        <div className="relative z-10 mt-6 flex items-center justify-center gap-2">
          <button
            onClick={onCycleTheme}
            className="button-base button-ghost flex items-center gap-1.5 px-3 py-1.5 text-ink-muted hover:text-ink hover:bg-surface-2 transition-colors rounded-lg"
            title="Toggle Theme"
          >
            {themeSetting === "system" ? (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-4 h-4"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25"
                />
              </svg>
            ) : themeSetting === "dark" ? (
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
                  d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                />
              </svg>
            ) : (
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
                  d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                />
              </svg>
            )}
          </button>
          <div className="w-px h-4 bg-surface-3"></div>
          <button
            onClick={() => {
              if (showProfile) setShowProfile(false);
              onToggleSettings();
            }}
            className={`button-base button-ghost flex items-center gap-1.5 px-3 py-1.5 transition-colors rounded-lg ${
              showSettings
                ? "text-primary bg-primary/10"
                : "text-ink-muted hover:text-ink hover:bg-surface-2"
            }`}
            title="Configure AI & Settings"
          >
            <span className="text-sm font-medium">Config</span>
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
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </button>
          <div className="w-px h-4 bg-surface-3"></div>
          <button
            onClick={() => {
              if (showSettings) onToggleSettings();
              setShowProfile(!showProfile);
            }}
            className={`button-base button-ghost flex items-center gap-1.5 px-3 py-1.5 transition-colors rounded-lg ${
              showProfile
                ? "text-primary bg-primary/10"
                : "text-ink-muted hover:text-ink hover:bg-surface-2"
            }`}
            title="Identity & Sign In"
          >
            <span className="text-sm font-medium">
              {identityMode === "user" ? "Profile" : "Sign In"}
            </span>
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
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
              />
            </svg>
          </button>
        </div>

        {showSettings && (
          <div className="relative z-10 mt-4 mx-auto w-full max-w-[720px] p-4 bg-surface-1 border border-surface-3 rounded-xl shadow-lg animate-in slide-in-from-top-2 text-left">
            <div className="flex justify-end mb-2">
              <button
                type="button"
                onClick={onToggleSettings}
                className="text-ink-muted hover:text-ink"
                aria-label="Close AI settings"
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
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            <AiSettings
              preference={aiRuntimePreference}
              onChangePreference={onChangeAiRuntimePreference}
              aiConfig={localAiConfig}
              onChangeAiConfig={onChangeLocalAiConfig}
              serverAiEnabled={serverAiEnabled}
            />
          </div>
        )}

        {showProfile && (
          <div className="relative z-10 mt-4 mx-auto w-full max-w-[720px] rounded-xl border border-surface-3 bg-surface-1 px-4 py-4 text-left text-xs text-ink-muted shadow-lg animate-in slide-in-from-top-2">
            <div className="mb-3 text-[11px] uppercase tracking-wider text-ink-muted flex items-center justify-between">
              <span>Account</span>
              <button
                onClick={() => setShowProfile(false)}
                className="text-ink-muted hover:text-ink"
                aria-label="Close profile"
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
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {identityWarning && (
              <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-700">
                {identityWarning}
              </div>
            )}

            <div className="mb-3 text-sm text-ink group relative cursor-help w-fit">
              {identityMode === "user" ? "Signed in as " : "Playing as "}
              <span className="font-mono font-bold">
                {identityMode === "user" ? identityLabel : "Guest"}
              </span>
              {identityMode === "guest" && (
                <span className="absolute left-full ml-2 top-0 bg-surface-3 text-ink px-1.5 py-0.5 rounded text-[10px] opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                  ID: {identityLabel}
                </span>
              )}
            </div>

            {identityMode === "user" ? (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={onSignOut}
                  disabled={authBusy}
                  className="button-base button-secondary px-3 py-1.5 text-xs"
                >
                  Sign out
                </button>
              </div>
            ) : !isIdentityAvailable ? (
              <div className="text-[11px] text-ink-muted">
                Sign-in is currently unavailable on this server.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-ink-muted leading-snug">
                  Sign in to keep the same identity across devices and browsers.
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="email"
                    value={authEmail}
                    onChange={(event) => onAuthEmailChange(event.target.value)}
                    placeholder="you@example.com"
                    className="flex-1 rounded-lg border border-surface-3 bg-surface-2 px-3 py-2 text-xs text-ink outline-none focus:border-brand-500 placeholder:text-ink-muted/50"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={onSendMagicLink}
                    disabled={authBusy}
                    className="button-base button-primary px-3 py-2 text-xs whitespace-nowrap"
                  >
                    Send Link to Sign In
                  </button>
                </div>
              </div>
            )}
            {authMessage && (
              <div
                className={`mt-3 text-[11px] p-2 rounded ${
                  authMessage === INVALID_EMAIL_MESSAGE ||
                  authMessage === INVALID_API_KEY_MESSAGE
                    ? "text-red-700 bg-red-50 border border-red-100"
                    : "text-primary bg-primary/5 border border-primary/10"
                }`}
              >
                {authMessage}
              </div>
            )}
          </div>
        )}

        <div className="relative z-10 mt-6">
          <SuitDivider />
        </div>
      </header>

      <div className="shrink-0 z-10 flex flex-col relative">
        <div className="px-4 flex-1">
          <JoinGameInput onJoin={onJoinManual} />
          {!isLobbyLoading && availableGames.length === 0 && (
            <div className="text-center py-12 px-6 rounded-2xl border-2 border-dashed border-surface-3 bg-surface-1/50">
              <p className="text-ink-muted mb-4">The library is empty.</p>
              <button
                onClick={onRefreshLobby}
                className="button-base button-secondary px-4 py-2 text-sm"
              >
                Refresh
              </button>
            </div>
          )}
          <div className="grid grid-cols-1 landscape:grid-cols-2 gap-3 pb-8">
            {sortedAvailableGames.map((game) => (
              <GameListItem
                key={game.id}
                game={game}
                activeCount={
                  activeGames.filter(
                    (g) => g.rulesId === game.id && g.status === "playing"
                  ).length
                }
                seatedCount={
                  recentGames.filter(
                    (rg) =>
                      rg.rulesId === game.id &&
                      rg.lastRole === "player" &&
                      activeGames.some((ag) => ag.gameId === rg.gameId)
                  ).length
                }
                onClick={() => onGameSelect(game)}
              />
            ))}
          </div>
        </div>
        <div className="relative mt-auto flex flex-col justify-end pt-2 pb-2">
          <BottomCornerOrnaments />
          <div className="relative z-10">
            <LobbyFooter
              onAboutClick={onAboutClick}
              backendRuntime={backendRuntime}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
