const { execFileSync } = require("node:child_process");

const env = process.env;
const envCommitSha =
  env.VERCEL_GIT_COMMIT_SHA ?? env.GITHUB_SHA ?? env.GIT_COMMIT_SHA ?? null;
const envCommitTimestamp =
  env.VERCEL_GIT_COMMIT_TIMESTAMP ??
  env.GIT_COMMIT_TIMESTAMP ??
  env.GIT_COMMIT_DATE ??
  null;

if (!envCommitSha) {
  try {
    env.GIT_COMMIT_SHA = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    console.error(
      "Missing commit SHA. Set VERCEL_GIT_COMMIT_SHA, GITHUB_SHA, or GIT_COMMIT_SHA."
    );
    process.exit(1);
  }
}

if (!envCommitTimestamp) {
  try {
    env.GIT_COMMIT_TIMESTAMP = execFileSync(
      "git",
      ["log", "-1", "--format=%ct"],
      { encoding: "utf8" }
    ).trim();
  } catch (error) {
    // Leave timestamp unset; the build will fallback to UTC build time.
  }
}
