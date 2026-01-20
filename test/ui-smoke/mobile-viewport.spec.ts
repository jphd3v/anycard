import { test, expect, devices } from "@playwright/test";
import {
  assertNoConsoleErrors,
  DEFAULT_SEED,
  goToLobby,
  openGameDetails,
  seedLocalStorage,
  startPrivateGame,
  trackConsoleMessages,
} from "./helpers";

// Use iPhone viewport
test.use(devices["iPhone 13"]);

// Mobile device emulation only works reliably in Chromium
test.describe("UI Smoke Tests - Mobile Viewport", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "Mobile viewport tests only run on Chromium"
  );
  test("Mobile - Home → game details sections", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);

    await expect(
      page.getByRole("heading", { name: /Join by Room ID/i })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Advanced/i })).toBeVisible();

    assertNoConsoleErrors(consoleMessages);
  });

  test("Mobile - Create and join room", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible({
      timeout: 15000,
    });

    await expect(page.getByTestId("seat-card:P1")).toBeVisible();
    await expect(page.getByTestId("seat-card:P2")).toBeVisible();

    assertNoConsoleErrors(consoleMessages, [/404/]);
  });

  test("Mobile - Join seat and start game", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await page.getByTestId("seat-join:P1").click();
    await expect(page.getByTestId("seat-state:P1")).toContainText(/Your Seat/i);

    await page.getByTestId("seat-ai-toggle:P2").click();
    // Wait for the game to be ready to start
    await page.waitForTimeout(500);

    // After enabling AI for P2, the "All players have joined" overlay may appear
    // Either start game button in overlay or in lobby
    const startGameButton = page.getByRole("button", { name: /^Start game$/i });
    await expect(startGameButton).toBeVisible({ timeout: 5000 });
    await startGameButton.click();

    await expect(page.locator(".game-layout").first()).toBeVisible({
      timeout: 15000,
    });

    assertNoConsoleErrors(consoleMessages, [/404/]);
  });

  test("Mobile - Room lobby minimize and restore", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await page.getByTestId("seat-join:P1").click();

    const lobbyHeading = page.getByRole("heading", { name: /Room Lobby/i });
    await expect(lobbyHeading).toBeVisible();

    const minimizeButton = page.locator('button[title="Minimize"]');
    await expect(minimizeButton).toBeVisible();
    await minimizeButton.click();

    await expect(lobbyHeading).toHaveCount(0);

    const restoreButton = page.getByRole("button", { name: /Room Lobby/i });
    await expect(restoreButton).toBeVisible();
    await restoreButton.click();

    await expect(lobbyHeading).toBeVisible();

    assertNoConsoleErrors(consoleMessages, [/404/]);
  });

  test("Mobile - Network disconnect shows reconnecting overlay", async ({
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

    // Simulate network disconnect
    await context.setOffline(true);

    // Should show reconnecting overlay
    await expect(page.getByText(/Reconnecting/i).first()).toBeVisible({
      timeout: 10000,
    });

    // Reconnect
    await context.setOffline(false);

    // Should see room lobby again
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible({
      timeout: 15000,
    });

    assertNoConsoleErrors(consoleMessages, [
      /ERR_INTERNET_DISCONNECTED/,
      /Failed to load resource/,
    ]);
  });
});
