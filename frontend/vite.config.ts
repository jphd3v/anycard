import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
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

export default defineConfig({
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
});
