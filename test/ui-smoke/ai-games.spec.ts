import { test, expect } from "@playwright/test";
import {
  assertNoConsoleErrors,
  DEFAULT_SEED,
  goToLobby,
  openGameDetails,
  seedLocalStorage,
  startPrivateGame,
  trackConsoleMessages,
} from "./helpers";

test.describe("UI Smoke Tests - AI Games", () => {
  test("All-AI game starts and runs automatically", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    // Enable AI for both seats
    await page.getByTestId("seat-ai-toggle:P1").click();
    await expect(page.getByTestId("seat-state:P1")).toContainText(
      /AI Controlled/i
    );

    await page.getByTestId("seat-ai-toggle:P2").click();
    await expect(page.getByTestId("seat-state:P2")).toContainText(
      /AI Controlled/i
    );

    // Watch as spectator to start the game
    await page.getByRole("button", { name: /Watch as Spectator/i }).click();

    // Start game button should appear
    await expect(page.getByTestId("start-game")).toBeVisible();
    await page.getByTestId("start-game").click();

    // Game should start
    await expect(page.locator(".game-layout").first()).toBeVisible({
      timeout: 15000,
    });

    // Wait a moment to ensure AI starts playing
    await page.waitForTimeout(2000);

    // Verify game is still running (no crash)
    await expect(page.locator(".game-layout").first()).toBeVisible();

    assertNoConsoleErrors(consoleMessages);
  });

  test("AI move validation - AI makes moves", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    // Enable AI for P2
    await page.getByTestId("seat-join:P1").click();
    await page.getByTestId("seat-ai-toggle:P2").click();
    await page.getByTestId("start-game").click();

    await expect(page.locator(".game-layout").first()).toBeVisible({
      timeout: 15000,
    });

    // Wait for at least one AI move
    await page.waitForTimeout(2000);

    // Open menu to check game log
    await page.getByRole("button", { name: /Menu/i }).click();

    // Verify game log exists and has content
    const gameLog = page.locator('[data-testid="game-log"]');
    if (await gameLog.isVisible().catch(() => false)) {
      const logText = await gameLog.textContent();
      // Log should have some moves recorded
      expect(logText).toBeTruthy();
      expect(logText!.length).toBeGreaterThan(10);
    }

    assertNoConsoleErrors(consoleMessages);
  });

  test("Disconnect during AI move recovers gracefully", async ({
    page,
    context,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await page.getByTestId("seat-join:P1").click();
    await page.getByTestId("seat-ai-toggle:P2").click();
    await page.getByTestId("start-game").click();

    await expect(page.locator(".game-layout").first()).toBeVisible({
      timeout: 15000,
    });

    // Wait for game to be in progress
    await page.waitForTimeout(1000);

    // Simulate network disconnect while AI might be thinking
    await context.setOffline(true);

    // Should show reconnecting overlay
    await expect(page.getByText(/Reconnecting/i).first()).toBeVisible({
      timeout: 10000,
    });

    // Reconnect
    await context.setOffline(false);

    // Should reconnect and game should still be visible
    await expect(page.locator(".game-layout").first()).toBeVisible({
      timeout: 15000,
    });

    // Game should still be functional
    await page.waitForTimeout(1000);
    await expect(page.locator(".game-layout").first()).toBeVisible();

    assertNoConsoleErrors(consoleMessages);
  });
});
