import { execFileSync } from "node:child_process";

export interface BackendBuildInfo {
  commitHash: string;
  commitUnixTs: number | null;
}

const SHORT_COMMIT_HASH_LENGTH = 7;

let cachedBuildInfo: BackendBuildInfo | null = null;

function normalizeCommitHash(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Keep non-SHA values (e.g. "dev") unchanged.
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
    return trimmed;
  }

  return trimmed.slice(0, SHORT_COMMIT_HASH_LENGTH).toLowerCase();
}

function readGitCommitHash(): string | null {
  try {
    const hash = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return hash || null;
  } catch {
    return null;
  }
}

function readGitCommitUnixTs(): number | null {
  try {
    const raw = execFileSync("git", ["log", "-1", "--format=%ct"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.floor(parsed) : null;
  } catch {
    return null;
  }
}

function parseUnixTimestamp(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  const ts = Math.floor(parsed);
  return ts >= 0 ? ts : null;
}

export function getBackendBuildInfo(): BackendBuildInfo {
  if (cachedBuildInfo) {
    return cachedBuildInfo;
  }

  const envHash =
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GITHUB_SHA ??
    process.env.GIT_COMMIT_SHA ??
    null;
  const envUnixTs =
    parseUnixTimestamp(process.env.VERCEL_GIT_COMMIT_TIMESTAMP) ??
    parseUnixTimestamp(process.env.GIT_COMMIT_TIMESTAMP) ??
    parseUnixTimestamp(process.env.GIT_COMMIT_DATE);

  const commitHash =
    normalizeCommitHash(envHash) ??
    normalizeCommitHash(readGitCommitHash()) ??
    "dev";
  const commitUnixTs = envUnixTs ?? readGitCommitUnixTs();

  cachedBuildInfo = {
    commitHash,
    commitUnixTs,
  };

  return cachedBuildInfo;
}
