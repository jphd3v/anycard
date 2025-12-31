import {
  type AiRuntimePreference,
  type LocalAiConfig,
  IS_BROWSER_LLM_ENABLED,
} from "../../state";

interface Props {
  preference: AiRuntimePreference;
  onChangePreference: (pref: AiRuntimePreference) => void;
  aiConfig: LocalAiConfig;
  onChangeAiConfig: (next: LocalAiConfig) => void;
  serverAiEnabled: boolean;
}

export function AiSettings({
  preference,
  onChangePreference,
  aiConfig,
  onChangeAiConfig,
  serverAiEnabled,
}: Props) {
  const handlePref = (next: AiRuntimePreference) => {
    if (next === "backend" && !serverAiEnabled) return;
    onChangePreference(next);
  };

  const options: AiRuntimePreference[] = IS_BROWSER_LLM_ENABLED
    ? ["backend", "frontend", "off"]
    : ["backend", "off"];

  const activeIndex = options.indexOf(preference);
  // specific logic for sliding indicator when some options might be missing
  // If preference is 'frontend' but feature is disabled, fallback to 'off' (index 1 in simplified list)
  const safeIndex =
    activeIndex === -1 ? (IS_BROWSER_LLM_ENABLED ? 2 : 1) : activeIndex;

  const numOptions = options.length;

  return (
    <div className="flex flex-col gap-3 text-left w-full">
      <div className="flex flex-col gap-2">
        <div className="text-[10px] uppercase tracking-wider text-ink-muted font-bold ml-1">
          AI Runtime Environment
        </div>

        {/* Sliding Segmented Control Container */}
        <div className="relative flex w-full bg-surface-3/50 p-1 rounded-lg select-none isolate h-9">
          {/*
             The Sliding Indicator
             - Uses 'bg-primary' to match the dark slate/blue in your theme
             - Text on top of this will need to be white/light
          */}
          <div
            className="absolute top-1 bottom-1 rounded-md bg-primary shadow-sm transition-all duration-300 ease-[cubic-bezier(0.25,1,0.5,1)] -z-10"
            style={{
              width: `calc((100% - 0.5rem) / ${numOptions})`, // (100% - 8px padding) / numOptions
              left: `0.25rem`, // 4px padding
              transform: `translateX(${safeIndex * 100}%)`,
            }}
          />

          {/* Button 1: Server AI */}
          <button
            type="button"
            data-testid="ai-runtime:server"
            className={`flex-1 text-xs font-bold rounded-md transition-colors duration-200 flex items-center justify-center ${
              preference === "backend"
                ? "text-white"
                : "text-ink-muted hover:text-ink"
            } ${
              !serverAiEnabled
                ? "opacity-50 cursor-not-allowed"
                : "cursor-pointer"
            }`}
            onClick={() => handlePref("backend")}
            disabled={!serverAiEnabled}
            title={
              serverAiEnabled
                ? "Use server AI"
                : "Server AI disabled (missing env vars)"
            }
          >
            Server
          </button>

          {/* Button 2: Browser AI (Conditional) */}
          {IS_BROWSER_LLM_ENABLED && (
            <button
              type="button"
              data-testid="ai-runtime:browser"
              className={`flex-1 text-xs font-bold rounded-md transition-colors duration-200 flex items-center justify-center ${
                preference === "frontend"
                  ? "text-white"
                  : "text-ink-muted hover:text-ink"
              }`}
              onClick={() => handlePref("frontend")}
            >
              Browser
            </button>
          )}

          {/* Button 3: Disabled */}
          <button
            type="button"
            className={`flex-1 text-xs font-bold rounded-md transition-colors duration-200 flex items-center justify-center ${
              preference === "off"
                ? "text-white"
                : "text-ink-muted hover:text-ink"
            }`}
            onClick={() => handlePref("off")}
          >
            Off
          </button>
        </div>
      </div>

      {preference === "frontend" && (
        <div className="grid gap-2 p-3 bg-surface-2/50 rounded-lg border border-surface-3 animate-in fade-in slide-in-from-top-1 duration-200 mt-1">
          <div className="text-[10px] uppercase tracking-wider text-ink-muted font-bold mb-1">
            Local LLM Configuration
          </div>
          <input
            type="text"
            className="w-full rounded-md border border-surface-3 bg-surface-1 px-3 py-2 text-xs text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-shadow"
            placeholder="Model (e.g. gpt-4o-mini)"
            value={aiConfig.model}
            onChange={(e) =>
              onChangeAiConfig({ ...aiConfig, model: e.target.value })
            }
          />
          <input
            type="text"
            className="w-full rounded-md border border-surface-3 bg-surface-1 px-3 py-2 text-xs text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-shadow"
            placeholder="API base URL"
            value={aiConfig.baseUrl}
            onChange={(e) =>
              onChangeAiConfig({ ...aiConfig, baseUrl: e.target.value })
            }
          />
          <input
            type="password"
            className="w-full rounded-md border border-surface-3 bg-surface-1 px-3 py-2 text-xs text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-shadow"
            placeholder="API key (optional)"
            value={aiConfig.apiKey}
            onChange={(e) =>
              onChangeAiConfig({ ...aiConfig, apiKey: e.target.value })
            }
          />
          {aiConfig.apiKey && (
            <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 leading-tight animate-in fade-in slide-in-from-top-1 duration-200">
              <strong>Security Warning:</strong> The API key is held in session
              storage and cleared when the tab closes. However, browser-based AI
              remains a security risk as keys can potentially leak via scripts
              or extensions.
            </div>
          )}
        </div>
      )}

      {!serverAiEnabled &&
        preference !== "frontend" &&
        preference !== "off" && (
          <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 animate-in fade-in">
            Server AI is currently disabled on this instance.
          </div>
        )}
    </div>
  );
}
