import type {
  ActiveGameSummary,
  AiRuntimePreference,
  AvailableGame,
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
  availableGames: AvailableGame[];
  sortedAvailableGames: AvailableGame[];
  activeGames: ActiveGameSummary[];
  recentGames: RecentGameEntry[];
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
  availableGames,
  sortedAvailableGames,
  activeGames,
  recentGames,
}: LobbyScreenProps) {
  return (
    <div className="flex-1 w-full flex flex-col max-w-lg landscape:max-w-none landscape:px-12 mx-auto h-full overflow-y-auto relative bg-surface-1 scrollbar-hide">
      <header className="relative pt-12 pb-2 px-6 text-center z-10 shrink-0">
        <TopCornerOrnaments />
        <h1 className="text-5xl md:text-6xl font-serif-display font-black text-ink mb-2 tracking-tight drop-shadow-sm relative z-10">
          AnyCard
        </h1>
        <p className="text-sm font-medium text-ink-muted uppercase tracking-[0.2em] opacity-80 relative z-10">
          Universal Card Game Engine
        </p>

        <div className="relative z-10 mt-4 flex items-center justify-center gap-2">
          <button
            onClick={onCycleTheme}
            className="button-base button-ghost flex items-center gap-1.5 px-3 py-1.5 text-ink-muted hover:text-ink hover:bg-surface-2 transition-colors rounded-lg"
            title="Toggle Theme"
          >
            <span className="text-sm font-medium">Theme</span>
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
            onClick={onToggleSettings}
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
        </div>

        {showSettings && (
          <div className="relative z-10 mt-4 mx-4 p-4 bg-surface-1 border border-surface-3 rounded-xl shadow-lg animate-in slide-in-from-top-2">
            <AiSettings
              preference={aiRuntimePreference}
              onChangePreference={onChangeAiRuntimePreference}
              aiConfig={localAiConfig}
              onChangeAiConfig={onChangeLocalAiConfig}
              serverAiEnabled={serverAiEnabled}
            />
          </div>
        )}

        <div className="relative z-10">
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
            <LobbyFooter onAboutClick={onAboutClick} />
          </div>
        </div>
      </div>
    </div>
  );
}
