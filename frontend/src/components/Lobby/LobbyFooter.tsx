import { useCallback } from "react";
import { copyToClipboard } from "../../utils/clipboard";
import type { BackendRuntimeInfo } from "../../state";

interface Props {
  onAboutClick?: () => void;
  backendRuntime: BackendRuntimeInfo | null;
}

function formatUnixTs(unixTs: number | null): string {
  if (unixTs == null) return "n/a";
  try {
    return new Date(unixTs * 1000).toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return "n/a";
  }
}

export function LobbyFooter({ onAboutClick, backendRuntime }: Props) {
  const commitHash =
    typeof __COMMIT_HASH__ !== "undefined" ? __COMMIT_HASH__ : "dev";
  const commitDate =
    typeof __COMMIT_DATE__ !== "undefined" ? __COMMIT_DATE__ : "";
  const year = new Date().getFullYear();
  const backendCommitHash = backendRuntime?.commitHash ?? "unknown";
  const backendCommitDate = formatUnixTs(backendRuntime?.commitUnixTs ?? null);

  const handleCopyVersion = useCallback(async () => {
    const text = `frontend #${commitHash} ${commitDate && `• ${commitDate}`} UTC\nbackend #${backendCommitHash} ${backendCommitDate !== "n/a" ? `• ${backendCommitDate}` : ""} UTC`;
    await copyToClipboard(text);
  }, [backendCommitDate, backendCommitHash, commitDate, commitHash]);

  return (
    <footer className="pt-3 pb-2 text-center text-ink-muted opacity-60 relative">
      <div className="text-2xs font-semibold uppercase tracking-widest mb-1">
        AnyCard Engine
      </div>
      <div className="text-2xs flex flex-col items-center justify-center gap-0.5">
        <span>&copy; {year} JPH</span>
        <button
          onClick={handleCopyVersion}
          className="font-mono opacity-80 hover:opacity-100 hover:text-ink transition-all cursor-pointer focus:outline-none active:scale-95"
          title="Click to copy version info"
        >
          frontend #{commitHash} {commitDate && `• ${commitDate}`} UTC
          <br />
          backend #{backendCommitHash}{" "}
          {backendCommitDate !== "n/a" && `• ${backendCommitDate}`} UTC
        </button>
      </div>
      {onAboutClick && (
        <button
          onClick={onAboutClick}
          className="mt-4 px-3 py-1.5 text-2xs font-bold uppercase tracking-widest text-ink-muted hover:text-ink hover:bg-surface-2 transition-all cursor-pointer rounded-lg border border-transparent hover:border-surface-3 active:scale-95 active:bg-surface-3/50 underline underline-offset-4 decoration-dotted"
        >
          About & License
        </button>
      )}
    </footer>
  );
}
