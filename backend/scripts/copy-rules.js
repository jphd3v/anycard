import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const source = path.resolve(projectRoot, "..", "rules");
const destinations = [
  path.resolve(projectRoot, "dist", "rules"),
  path.resolve(projectRoot, "dist", "backend", "rules"),
];

for (const dest of destinations) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(source, dest, { recursive: true });
  console.log(`[postbuild] Copied rules to ${dest}`);
}
