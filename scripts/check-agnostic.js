#!/usr/bin/env node

/**
 * Agnostic Boundary Enforcement Script
 *
 * Scans generic engine/UI code to ensure no game-specific logic has leaked in.
 *
 * Forbidden:
 * - Game names (bridge, canasta, etc.)
 * - Game-specific domain terms (trick, meld, bid, etc.)
 * - rulesId switching (if/switch on rulesId in generic code)
 *
 * Usage:
 *   node scripts/check-agnostic.js
 *
 * Exit codes:
 *   0 - All checks passed
 *   1 - Violations found
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// Load configuration
const configPath = path.join(__dirname, "agnostic-config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

const FORBIDDEN_TOKENS = config.forbiddenTokens;
const ALLOWED_EXCEPTIONS = config.allowedExceptions || {};

/**
 * Safely resolve a path and ensure it's within the ROOT directory.
 * Prevents path traversal attacks.
 */
function safeResolve(basePath, ...segments) {
  // This is the security validation itself - we resolve the path to detect traversal
  const resolved = path.resolve(basePath, ...segments); // nosemgrep
  const normalized = path.normalize(resolved);

  // Ensure the resolved path is within the base path
  if (
    !normalized.startsWith(path.normalize(basePath) + path.sep) &&
    normalized !== path.normalize(basePath)
  ) {
    throw new Error(
      `Path traversal detected: "${segments.join("/")}" resolves outside base directory`
    );
  }

  return normalized;
}

const SCAN_PATHS = config.scanPaths.map((p) => safeResolve(ROOT, p));

// Regex patterns
const RULES_ID_SWITCH_PATTERN =
  /\b(if|switch)\s*\(\s*[^)]*rulesId\s*[=!]=|rulesId\s*===\s*["']/;
const EXCEPTION_MARKER_PATTERN = /\/\/\s*agnostic-allow:\s*(.+)/;

// Results
const violations = [];
let filesScanned = 0;

/**
 * Check if a file path is allowed to have exceptions
 */
function isExceptionAllowed(filePath, token) {
  for (const [pattern, allowed] of Object.entries(ALLOWED_EXCEPTIONS)) {
    if (filePath.includes(pattern)) {
      if (allowed === "all" || allowed.includes(token)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Scan a single file for violations
 */
function scanFile(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const relPath = path.relative(ROOT, filePath);

  lines.forEach((line, lineNum) => {
    const lineNumber = lineNum + 1;
    const trimmed = line.trim();

    // Skip comment-only lines
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    ) {
      return;
    }

    // Remove inline comments before checking
    const codeOnly = line.split("//")[0];

    // Check for exception marker
    const exceptionMatch = line.match(EXCEPTION_MARKER_PATTERN);
    const allowedOnThisLine = exceptionMatch
      ? exceptionMatch[1]
          .trim()
          .split(",")
          .map((t) => t.trim())
      : [];

    // Check for forbidden tokens (case-insensitive, word boundaries)
    for (const token of FORBIDDEN_TOKENS) {
      if (allowedOnThisLine.includes(token)) continue;
      if (isExceptionAllowed(relPath, token)) continue;

      const regex = new RegExp(`\\b${token}\\b`, "i");
      if (regex.test(codeOnly)) {
        violations.push({
          file: relPath,
          line: lineNumber,
          type: "forbidden-token",
          token: token,
          context: line.trim(),
        });
      }
    }

    // Check for rulesId switching
    if (RULES_ID_SWITCH_PATTERN.test(codeOnly)) {
      if (!isExceptionAllowed(relPath, "rulesId-switch")) {
        violations.push({
          file: relPath,
          line: lineNumber,
          type: "rulesid-switch",
          context: line.trim(),
        });
      }
    }
  });

  filesScanned++;
}

/**
 * Recursively scan directory
 */
function scanDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    console.warn(`Warning: Path does not exist: ${dirPath}`);
    return;
  }

  const stat = fs.statSync(dirPath);

  if (stat.isFile()) {
    if (
      dirPath.endsWith(".ts") ||
      dirPath.endsWith(".tsx") ||
      dirPath.endsWith(".js") ||
      dirPath.endsWith(".jsx")
    ) {
      scanFile(dirPath);
    }
    return;
  }

  if (!stat.isDirectory()) return;

  const entries = fs.readdirSync(dirPath);

  for (const entry of entries) {
    // Prevent path traversal by validating the resolved path stays within ROOT
    const fullPath = safeResolve(dirPath, entry);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      // Skip node_modules, dist, etc.
      if (entry === "node_modules" || entry === "dist" || entry === ".git")
        continue;
      scanDirectory(fullPath);
    } else if (stat.isFile()) {
      if (
        fullPath.endsWith(".ts") ||
        fullPath.endsWith(".tsx") ||
        fullPath.endsWith(".js") ||
        fullPath.endsWith(".jsx")
      ) {
        scanFile(fullPath);
      }
    }
  }
}

/**
 * Main execution
 */
function main() {
  console.log("🔍 Checking engine agnostic boundary...\n");
  console.log(`Scanning ${SCAN_PATHS.length} path(s):`);
  SCAN_PATHS.forEach((p) => console.log(`  - ${path.relative(ROOT, p)}`));
  console.log();

  // Scan all configured paths
  for (const scanPath of SCAN_PATHS) {
    scanDirectory(scanPath);
  }

  console.log(`✓ Scanned ${filesScanned} files\n`);

  // Report violations
  if (violations.length === 0) {
    console.log("✅ No violations found. Engine boundary is clean!\n");
    process.exit(0);
  }

  console.error(`❌ Found ${violations.length} violation(s):\n`);

  // Group by file
  const byFile = {};
  for (const v of violations) {
    if (!byFile[v.file]) byFile[v.file] = [];
    byFile[v.file].push(v);
  }

  for (const [file, fileViolations] of Object.entries(byFile)) {
    console.error(`📁 ${file}:`);
    for (const v of fileViolations) {
      if (v.type === "forbidden-token") {
        console.error(`   Line ${v.line}: Forbidden token "${v.token}"`);
        console.error(`      ${v.context}`);
      } else if (v.type === "rulesid-switch") {
        console.error(`   Line ${v.line}: rulesId switching detected`);
        console.error(`      ${v.context}`);
      }
    }
    console.error();
  }

  console.error("💡 To fix:");
  console.error("   1. Move game-specific logic to rule modules");
  console.error("   2. Use plugin hooks instead of switch/if on rulesId");
  console.error("   3. Add // agnostic-allow: <token> if absolutely necessary");
  console.error("");
  console.error("📖 See docs/ENGINE_AGNOSTIC_BOUNDARY.md for details\n");

  process.exit(1);
}

main();
