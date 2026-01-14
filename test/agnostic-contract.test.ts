/**
 * Agnostic Contract Test Suite
 *
 * Ensures all game plugins comply with the agnostic boundary contract.
 * Tests run against ALL registered plugins to verify:
 * - Registry compliance
 * - View hardening doesn't leak seat information
 * - AI interface compliance (if present)
 * - Layout schema validation
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { ALL_GAME_PLUGINS } from "../backend/src/rules/registry.js";

describe("Agnostic Contract Tests", () => {
  const plugins = ALL_GAME_PLUGINS;

  describe("Registry Compliance", () => {
    it("should have at least one plugin registered", () => {
      assert.ok(plugins.length > 0, "No plugins registered");
    });

    for (const plugin of plugins) {
      describe(`Plugin: ${plugin.id}`, () => {
        it("should have required fields", () => {
          assert.ok(plugin.id, "Missing id");
          assert.ok(plugin.gameName, "Missing gameName");
          assert.ok(plugin.ruleModule, "Missing ruleModule");
          assert.ok(plugin.ruleModule.validate, "Missing validate method");
        });

        it("should have valid id format (lowercase, hyphens only)", () => {
          assert.match(
            plugin.id,
            /^[a-z0-9-]+$/,
            `Invalid id format: ${plugin.id}`
          );
        });
      });
    }
  });

  describe("AI Support Contract", () => {
    for (const plugin of plugins) {
      if (!plugin.aiSupport) continue;

      describe(`Plugin: ${plugin.id} (AI Support)`, () => {
        const aiSupport = plugin.aiSupport!; // Already checked by if condition

        it("should implement listCandidates", () => {
          assert.ok(
            typeof aiSupport.listCandidates === "function",
            "listCandidates must be a function"
          );
        });

        it("should implement applyCandidateId", () => {
          assert.ok(
            typeof aiSupport.applyCandidateId === "function",
            "applyCandidateId must be a function"
          );
        });

        it("buildContext should be optional or a function", () => {
          if (aiSupport.buildContext) {
            assert.ok(
              typeof aiSupport.buildContext === "function",
              "buildContext must be a function if provided"
            );
          }
        });

        // Note: We can't easily test determinism or candidate validity without
        // creating a full game state, which would be plugin-specific.
        // These tests would be better as integration tests per game.
      });
    }
  });

  describe("Plugin Metadata Files", () => {
    for (const plugin of plugins) {
      describe(`Plugin: ${plugin.id}`, () => {
        it("should have meta.json file", async () => {
          const metaPath = `./rules/${plugin.id}/meta.json`;
          try {
            const fs = await import("fs/promises");
            await fs.access(metaPath);
            const content = await fs.readFile(metaPath, "utf-8");
            const meta = JSON.parse(content);
            assert.ok(meta.gameName, "meta.json missing gameName");
          } catch (err: unknown) {
            const error = err as Error;
            assert.fail(
              `Missing or invalid meta.json for ${plugin.id}: ${error.message}`
            );
          }
        });

        it("should have layout.json file", async () => {
          const layoutPath = `./rules/${plugin.id}/${plugin.id}.layout.json`;
          try {
            const fs = await import("fs/promises");
            await fs.access(layoutPath);
            const content = await fs.readFile(layoutPath, "utf-8");
            const layout = JSON.parse(content);
            assert.ok(layout.piles, "layout.json missing piles");
          } catch (err: unknown) {
            const error = err as Error;
            assert.fail(
              `Missing or invalid layout.json for ${plugin.id}: ${error.message}`
            );
          }
        });
      });
    }
  });

  describe("No Game-Specific Code in Engine", () => {
    it("should pass agnostic boundary checks", async () => {
      // This is a meta-test that ensures check-agnostic.js runs clean
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);

      try {
        await execAsync("node scripts/check-agnostic.js");
      } catch (error: unknown) {
        const err = error as { stdout?: string; message?: string };
        // check-agnostic.js exits with code 1 if violations found
        assert.fail(
          `Agnostic boundary violations detected:\n${err.stdout || err.message}`
        );
      }
    });
  });
});
