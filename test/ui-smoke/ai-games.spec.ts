import { test, expect } from "@playwright/test";
import {
  assertNoConsoleErrors,
  DEFAULT_RULES_ID,
  DEFAULT_SEED,
  goToLobby,
  openGameDetails,
  readRoomIdFromLobby,
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

    // Give AI time to play a few moves — we just need to confirm no crash
    await page.waitForTimeout(3000);

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

    // Wait for AI to make at least one move before checking the log
    await page.waitForTimeout(3000);

    // Open the game log via the "Show game log" button (TurnStatusBadge)
    await page.getByRole("button", { name: /Show game log/i }).click();

    // Verify the game log dialog opened and has content
    const gameLogDialog = page.getByRole("dialog", { name: /Game Log/i });
    await expect(gameLogDialog).toBeVisible({ timeout: 5000 });
    const logText = await gameLogDialog.textContent();
    // Log should have some moves recorded
    expect(logText).toBeTruthy();
    expect(logText!.length).toBeGreaterThan(10);

    assertNoConsoleErrors(consoleMessages);
  });

  test("Game log AI toggle does not duplicate executed action rows", async ({
    page,
    browser,
  }) => {
    const consoleMessages = trackConsoleMessages(page);
    const playerTwoContext = await browser.newContext();
    const playerTwoPage = await playerTwoContext.newPage();
    const playerTwoConsoleMessages = trackConsoleMessages(playerTwoPage);

    try {
      await goToLobby(page);
      await openGameDetails(page);
      await startPrivateGame(page, DEFAULT_SEED);

      await page.getByTestId("seat-join:P1").click();
      const roomId = await readRoomIdFromLobby(page);

      await playerTwoPage.goto(`/${DEFAULT_RULES_ID}/${roomId}`);
      await expect(
        playerTwoPage.getByRole("heading", { name: /Room Lobby/i })
      ).toBeVisible({ timeout: 15000 });
      await playerTwoPage.getByTestId("seat-join:P2").click();

      await expect(page.getByTestId("start-game")).toBeVisible({
        timeout: 10000,
      });
      await page.getByTestId("start-game").click();

      await expect(page.locator(".game-layout").first()).toBeVisible({
        timeout: 15000,
      });

      await page.getByRole("button", { name: /Show game log/i }).click();

      const gameLogDialog = page.getByRole("dialog", { name: /Game Log/i });
      await expect(gameLogDialog).toBeVisible();
      const aiToggle = gameLogDialog.getByRole("checkbox", {
        name: /Show AI events/i,
      });
      await expect(aiToggle).not.toBeChecked();
      await expect(
        gameLogDialog.getByText(/Action:\s*start-game/i)
      ).toBeHidden();

      await aiToggle.check();
      await expect(aiToggle).toBeChecked();
      await expect(
        gameLogDialog.getByText(/Action:\s*start-game/i)
      ).toBeHidden();

      await aiToggle.uncheck();
      await expect(aiToggle).not.toBeChecked();
      await expect(
        gameLogDialog.getByText(/Action:\s*start-game/i)
      ).toBeHidden();

      assertNoConsoleErrors(consoleMessages);
      assertNoConsoleErrors(playerTwoConsoleMessages);
    } finally {
      await playerTwoContext.close();
    }
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

    // Ensure game state has loaded before simulating disconnect
    await expect(page.locator("[data-testid^='pile:']").first()).toBeVisible({
      timeout: 10000,
    });

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

    // Game should still be functional — verify piles are rendered after reconnect
    await expect(page.locator("[data-testid^='pile:']").first()).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator(".game-layout").first()).toBeVisible();

    assertNoConsoleErrors(consoleMessages);
  });
});
