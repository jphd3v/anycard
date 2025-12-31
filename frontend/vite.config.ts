import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "node:child_process";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  ".."
);

const commitHash = execSync("git rev-parse --short HEAD").toString().trim();
const commitDate = execSync(
  "git log -1 --format=%cd --date=format:'%Y-%m-%d %H:%M'"
)
  .toString()
  .trim();

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
