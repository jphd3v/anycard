#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const rulesDir = path.resolve(repoRoot, "backend/src/rules/impl");
const summaryPath = path.resolve(
  repoRoot,
  process.env.RULES_COVERAGE_SUMMARY ??
    "test-artifacts/integration-coverage/coverage-summary.json"
);
const thresholdRaw = process.env.RULES_COVERAGE_THRESHOLD ?? "90";
const threshold = Number(thresholdRaw);

if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
  throw new Error(
    `[coverage] Invalid RULES_COVERAGE_THRESHOLD='${thresholdRaw}'. Expected a number between 0 and 100.`
  );
}

if (!fs.existsSync(summaryPath)) {
  throw new Error(
    `[coverage] Coverage summary not found at ${summaryPath}. Run 'npm run test:integration:coverage' first.`
  );
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

const entries = Object.entries(summary).filter(([key]) => key !== "total");

function normalizePathLike(value) {
  return value.replace(/\\/g, "/");
}

function coverageForRelativeFile(relativeFile) {
  const normalizedRelative = normalizePathLike(relativeFile);
  for (const [key, value] of entries) {
    const normalizedKey = normalizePathLike(key);
    if (normalizedKey.endsWith(normalizedRelative)) {
      return value;
    }
    const resolved = normalizePathLike(path.resolve(repoRoot, key));
    if (resolved.endsWith(normalizedRelative)) {
      return value;
    }
  }
  return null;
}

const ruleFiles = fs
  .readdirSync(rulesDir)
  .filter((file) => file.endsWith(".ts") && file !== "template-game.ts")
  .sort();

const results = ruleFiles.map((file) => {
  const relativeFile = normalizePathLike(
    path.join("backend/src/rules/impl", file)
  );
  const coverage = coverageForRelativeFile(relativeFile);
  const linesPct = coverage?.lines?.pct ?? 0;
  const statementsPct = coverage?.statements?.pct ?? 0;
  const functionsPct = coverage?.functions?.pct ?? 0;
  const branchesPct = coverage?.branches?.pct ?? 0;
  return {
    file: relativeFile,
    linesPct,
    statementsPct,
    functionsPct,
    branchesPct,
    pass: linesPct >= threshold,
  };
});

console.log(
  `[coverage] Rules integration coverage threshold: ${threshold.toFixed(1)}% lines per game`
);
for (const result of results) {
  const status = result.pass ? "PASS" : "FAIL";
  console.log(
    `[coverage] ${status} ${result.file} lines=${result.linesPct.toFixed(1)}% statements=${result.statementsPct.toFixed(1)}% functions=${result.functionsPct.toFixed(1)}% branches=${result.branchesPct.toFixed(1)}%`
  );
}

const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  const failedList = failed
    .map((r) => `${r.file} (${r.linesPct.toFixed(1)}%)`)
    .join(", ");
  throw new Error(
    `[coverage] ${failed.length} game rule module(s) below ${threshold.toFixed(1)}% line coverage: ${failedList}`
  );
}

const total = summary.total;
if (total?.lines?.pct !== undefined) {
  console.log(
    `[coverage] Aggregate lines=${Number(total.lines.pct).toFixed(1)}% statements=${Number(total.statements?.pct ?? 0).toFixed(1)}% functions=${Number(total.functions?.pct ?? 0).toFixed(1)}% branches=${Number(total.branches?.pct ?? 0).toFixed(1)}%`
  );
}
