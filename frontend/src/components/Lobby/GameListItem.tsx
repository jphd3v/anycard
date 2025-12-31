import type { AvailableGame } from "../../state";

interface Props {
  game: AvailableGame;
  activeCount?: number;
  seatedCount?: number;
  onClick: () => void;
}

function formatPlayers(minPlayers?: number, maxPlayers?: number): string {
  if (typeof minPlayers === "number" && typeof maxPlayers === "number") {
    return minPlayers === maxPlayers
      ? `${minPlayers} Players`
      : `${minPlayers}-${maxPlayers} Players`;
  }
  if (typeof minPlayers === "number") {
    return `${minPlayers}+ Players`;
  }
  return "Players";
}

export function GameListItem({
  game,
  activeCount = 0,
  seatedCount = 0,
  onClick,
}: Props) {
  const playersLabel = formatPlayers(game.minPlayers, game.maxPlayers);
  const categoryLabel = game.category || "Card Game";

  return (
    <div
      onClick={onClick}
      data-testid={`game:${game.id}`}
      className="group relative bg-surface-1 hover:bg-surface-2 border border-surface-3 rounded-xl p-4 transition-all duration-200 active:scale-[0.98] cursor-pointer shadow-sm hover:shadow-md overflow-hidden"
    >
      {/* Decorative side bar */}
      <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-surface-3 group-hover:bg-primary transition-colors" />

      <div className="pl-3 flex justify-between items-start">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-serif-display font-bold text-ink group-hover:text-primary transition-colors">
              {game.name}
            </h3>
            {activeCount > 0 && (
              <span className="text-[10px] font-sans font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full uppercase tracking-wide">
                {activeCount} In Progress
              </span>
            )}
            {seatedCount > 0 && (
              <span className="text-[10px] font-sans font-bold text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full uppercase tracking-wide">
                {seatedCount === 1 ? "Seated" : `${seatedCount} Seated`}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-ink-muted uppercase tracking-wider font-semibold">
            <span>{categoryLabel}</span>
            <span className="w-1 h-1 rounded-full bg-surface-3" />
            <span>{playersLabel}</span>
          </div>
          <p className="mt-2 text-sm text-ink-muted leading-relaxed line-clamp-2">
            {game.description || "A classic card game."}
          </p>
        </div>

        {/* Chevron */}
        <div className="text-surface-3 group-hover:text-primary transition-colors mt-1">
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5l7 7-7 7"
            />
          </svg>
        </div>
      </div>
    </div>
  );
}
