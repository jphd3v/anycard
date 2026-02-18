import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  ".."
);

const envCommitSha =
  process.env.VERCEL_GIT_COMMIT_SHA ??
  process.env.GITHUB_SHA ??
  process.env.GIT_COMMIT_SHA ??
  null;
const envCommitDate =
  process.env.VERCEL_GIT_COMMIT_TIMESTAMP ??
  process.env.GIT_COMMIT_DATE ??
  process.env.GIT_COMMIT_TIMESTAMP ??
  null;
const envCommitShort = envCommitSha ? envCommitSha.slice(0, 7) : null;
const buildTimestamp = new Date().toISOString().slice(0, 16).replace("T", " ");

if (!envCommitShort) {
  throw new Error(
    "Missing commit SHA. Set VERCEL_GIT_COMMIT_SHA, GITHUB_SHA, or GIT_COMMIT_SHA."
  );
}
const commitHash = envCommitShort;
const commitDate = (() => {
  if (!envCommitDate) {
    return buildTimestamp;
  }
  const numeric = Number(envCommitDate);
  if (Number.isFinite(numeric)) {
    const ms = envCommitDate.length <= 10 ? numeric * 1000 : numeric;
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
  const parsed = new Date(envCommitDate);
  if (!Number.isNaN(parsed.valueOf())) {
    return parsed.toISOString().slice(0, 16).replace("T", " ");
  }
  return buildTimestamp;
})();

function isLocalhostLikeHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function validateSupabaseEnvForProductionBuild(
  command: "build" | "serve",
  mode: string
): void {
  if (command !== "build" || mode !== "production") {
    return;
  }

  const loadedEnv = loadEnv(mode, process.cwd(), "");
  const resolvedEnv = { ...loadedEnv, ...process.env };

  const supabaseUrl = resolvedEnv.VITE_SUPABASE_URL?.trim();
  const supabaseKey = resolvedEnv.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  const supabaseRedirectTo =
    resolvedEnv.VITE_SUPABASE_EMAIL_REDIRECT_TO?.trim();
  const anySupabaseEnvSet = Boolean(
    supabaseUrl || supabaseKey || supabaseRedirectTo
  );

  if (!anySupabaseEnvSet) {
    return;
  }

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Invalid Supabase env configuration: set both VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY for production builds."
    );
  }

  if (!supabaseRedirectTo) {
    throw new Error(
      "Invalid Supabase env configuration: set VITE_SUPABASE_EMAIL_REDIRECT_TO to your public HTTPS app URL for production builds."
    );
  }

  let parsedRedirectTo: URL;
  try {
    parsedRedirectTo = new URL(supabaseRedirectTo);
  } catch {
    throw new Error(
      "Invalid Supabase env configuration: VITE_SUPABASE_EMAIL_REDIRECT_TO must be a full URL."
    );
  }

  if (parsedRedirectTo.protocol !== "https:") {
    throw new Error(
      "Invalid Supabase env configuration: VITE_SUPABASE_EMAIL_REDIRECT_TO must use https:// in production builds."
    );
  }

  if (isLocalhostLikeHost(parsedRedirectTo.hostname)) {
    throw new Error(
      "Invalid Supabase env configuration: VITE_SUPABASE_EMAIL_REDIRECT_TO cannot point to localhost in production builds."
    );
  }
}

export default defineConfig(({ command, mode }) => {
  validateSupabaseEnvForProductionBuild(command, mode);

  return {
    plugins: [react(), tailwindcss()],
    define: {
      __COMMIT_HASH__: JSON.stringify(commitHash),
      __COMMIT_DATE__: JSON.stringify(commitDate),
    },
    server: {
      host: true,
      fs: {
        allow: [workspaceRoot],
      },
    },
  };
});
