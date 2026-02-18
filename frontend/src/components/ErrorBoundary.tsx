import { Component, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import type { GameLogEntry } from "../../../shared/schemas";
import { copyToClipboard } from "../utils/clipboard";
import {
  gameIdAtom,
  gameLogAtom,
  gameViewAtom,
  roomSeedAtom,
  rulesIdAtom,
} from "../state";
import { fetchGameLog } from "../socket";
import { ScrollShadowWrapper } from "./ScrollShadowWrapper";

interface Props {
  children: ReactNode;
  gameId?: string | null;
  rulesId?: string | null;
  gameName?: string | null;
  seed?: string | null;
  gameLog?: GameLogEntry[];
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

function formatTimestampWithMs(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) return "";
  const base = parsed.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  return `${base}.${String(parsed.getMilliseconds()).padStart(3, "0")}`;
}

function formatGameLogForClipboard({
  gameName,
  gameId,
  seed,
  entries,
}: {
  gameName?: string | null;
  gameId?: string | null;
  seed?: string | null;
  entries: GameLogEntry[];
}): string {
  const title = gameName?.trim() || "Unknown";
  const roomId = gameId?.trim() || "unknown";
  const seedLabel = seed?.trim() || "unknown";

  let output = `Game log: ${title} (room id: ${roomId}, seed ${seedLabel})\n\n`;
  if (entries.length === 0) {
    output += "No game log entries available.";
    return output;
  }

  const grouped = new Map<number, GameLogEntry[]>();
  for (const entry of [...entries].sort((a, b) => a.index - b.index)) {
    if (!grouped.has(entry.turnNumber)) {
      grouped.set(entry.turnNumber, []);
    }
    grouped.get(entry.turnNumber)!.push(entry);
  }

  for (const [turnNumber, groupEntries] of grouped.entries()) {
    const actor = groupEntries.find((entry) => entry.actorId)?.actorId;
    const heading = turnNumber > 0 ? `Turn ${turnNumber}` : "Setup";
    output += actor ? `${heading} · ${actor}\n` : `${heading}\n`;

    for (const entry of groupEntries) {
      if (entry.timestamp) {
        const ts = formatTimestampWithMs(entry.timestamp);
        output += `${ts} ${entry.message}\n`;
      } else {
        output += `${entry.message}\n`;
      }
    }
    output += "\n";
  }

  return output.trimEnd();
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ errorInfo });
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  handleCopyError = async () => {
    const { error, errorInfo } = this.state;
    const errorText = [
      "Error:",
      error?.message ?? "Unknown error",
      "",
      "Stack:",
      error?.stack ?? "No stack trace",
      "",
      "Component Stack:",
      errorInfo?.componentStack ?? "No component stack",
      "",
      "URL:",
      window.location.href,
      "",
      "User Agent:",
      navigator.userAgent,
      "",
      "Timestamp:",
      new Date().toISOString(),
    ].join("\n");

    await copyToClipboard(errorText);
  };

  handleCopyGameLog = async () => {
    const { gameId, gameName, rulesId, seed } = this.props;
    let entries = this.props.gameLog ?? [];

    if (gameId) {
      try {
        entries = await fetchGameLog(gameId);
      } catch (error) {
        console.error(
          "Failed to fetch latest game log in ErrorBoundary",
          error
        );
      }
    }

    const gameLabel = gameName ?? rulesId ?? "Unknown";
    const logText = formatGameLogForClipboard({
      gameName: gameLabel,
      gameId,
      seed,
      entries,
    });

    await copyToClipboard(logText);
  };

  handleTryContinue = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  handleReturnHome = () => {
    window.history.pushState({}, "", "/");
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      const { error, errorInfo } = this.state;

      return (
        <div
          data-testid="error-boundary"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-surface-0/90 backdrop-blur-sm"
        >
          <div className="max-w-lg w-full mx-4 rounded-2xl border border-surface-3 bg-surface-1 shadow-xl p-6 flex flex-col gap-4">
            <div>
              <h1 className="text-lg font-semibold text-ink mb-1">
                Something went wrong
              </h1>
              <p className="text-sm text-ink-muted">
                An unexpected error occurred in the application. You can try to
                continue, but the app may be in an unstable state.
              </p>
            </div>

            <ScrollShadowWrapper className="text-xs font-mono bg-surface-2/80 rounded-lg max-h-48">
              <div className="p-3 w-fit min-w-full space-y-2">
                <div className="text-red-600 font-semibold">
                  {error?.name}: {error?.message}
                </div>
                {error?.stack && (
                  <pre className="text-ink-muted whitespace-pre-wrap break-words text-2xs">
                    {error.stack}
                  </pre>
                )}
                {errorInfo?.componentStack && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-ink-muted hover:text-ink">
                      Component Stack
                    </summary>
                    <pre className="mt-1 text-ink-muted whitespace-pre-wrap break-words text-2xs">
                      {errorInfo.componentStack}
                    </pre>
                  </details>
                )}
              </div>
            </ScrollShadowWrapper>

            <div className="flex flex-wrap justify-end gap-3 pt-2">
              <button
                type="button"
                className="button-secondary px-3 py-1.5 text-sm"
                onClick={this.handleCopyGameLog}
              >
                Copy game log
              </button>
              <button
                type="button"
                className="button-secondary px-3 py-1.5 text-sm"
                onClick={this.handleCopyError}
              >
                Copy error info
              </button>
              <button
                type="button"
                className="button-secondary px-3 py-1.5 text-sm"
                onClick={this.handleTryContinue}
              >
                Try to continue
              </button>
              <button
                type="button"
                className="button-primary px-3 py-1.5 text-sm"
                onClick={this.handleReturnHome}
              >
                Return to Home
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

interface AppErrorBoundaryProps {
  children: ReactNode;
}

export function AppErrorBoundary({ children }: AppErrorBoundaryProps) {
  const gameId = useAtomValue(gameIdAtom);
  const rulesId = useAtomValue(rulesIdAtom);
  const view = useAtomValue(gameViewAtom);
  const roomSeed = useAtomValue(roomSeedAtom);
  const gameLog = useAtomValue(gameLogAtom);

  const metadataSeed =
    view?.metadata && typeof view.metadata.seed === "string"
      ? view.metadata.seed
      : null;
  const effectiveSeed = metadataSeed ?? roomSeed ?? null;

  return (
    <ErrorBoundary
      gameId={gameId}
      rulesId={rulesId}
      gameName={view?.gameName ?? rulesId ?? null}
      seed={effectiveSeed}
      gameLog={gameLog}
    >
      {children}
    </ErrorBoundary>
  );
}
