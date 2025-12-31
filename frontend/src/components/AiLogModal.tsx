import { useAtom } from "jotai";
import { aiLogAtom, aiLogVisibleAtom } from "../state";
import type { AiLogEntry } from "../state";
import { ScrollShadowWrapper } from "./ScrollShadowWrapper";

export function AiLogModal() {
  const [log] = useAtom(aiLogAtom);
  const [visible, setVisible] = useAtom(aiLogVisibleAtom);

  if (!visible) return null;

  // Group by turnNumber for nicer formatting
  const turns = groupByTurn(log);

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-surface-0/80 backdrop-blur-sm">
      <div className="max-w-2xl w-full mx-4 rounded-2xl border border-surface-3 bg-surface-1 shadow-xl p-4 flex flex-col gap-3">
        <div className="flex justify-between items-center">
          <h2 className="text-base font-semibold text-ink">Game log</h2>
          <button
            type="button"
            className="text-sm text-ink-muted hover:text-ink"
            onClick={() => setVisible(false)}
          >
            Close
          </button>
        </div>

        <ScrollShadowWrapper className="border border-surface-3 rounded-lg max-h-[60vh] text-xs font-mono">
          <div className="p-3 w-fit min-w-full space-y-3">
            {turns.map(([turnNumber, entries]) => (
              <div key={turnNumber}>
                <div className="font-semibold mb-1">Turn {turnNumber ?? 0}</div>
                {entries.map((entry, idx) => (
                  <div key={idx} className="ml-3 mb-1">
                    <div className="flex items-baseline gap-2">
                      <span
                        className={
                          entry.level === "error"
                            ? "text-red-600"
                            : entry.level === "warn"
                              ? "text-amber-600"
                              : "text-ink-muted"
                        }
                      >
                        [{entry.phase}]
                      </span>
                      <span>{entry.message}</span>
                    </div>
                    {entry.details != null && (
                      <pre className="ml-5 mt-0.5 whitespace-pre-wrap break-words opacity-80">
                        {formatDetails(entry)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </ScrollShadowWrapper>
      </div>
    </div>
  );
}

function groupByTurn(log: AiLogEntry[]): [number, AiLogEntry[]][] {
  const map = new Map<number, AiLogEntry[]>();
  for (const entry of log) {
    const t = entry.turnNumber ?? 0;
    const arr = map.get(t) ?? [];
    arr.push(entry);
    map.set(t, arr);
  }
  return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
}

function formatDetails(entry: AiLogEntry): string {
  try {
    const details = entry.details as Record<string, unknown> | undefined;

    // Special handling for raw LLM response to show reasoning text nicely.
    if (
      details?.kind === "llm-response-raw" &&
      typeof details.content === "string"
    ) {
      return details.content;
    }

    return JSON.stringify(details, null, 2);
  } catch {
    return String(entry.details);
  }
}
