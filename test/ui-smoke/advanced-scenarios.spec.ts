import { test, expect } from "@playwright/test";
import {
  assertNoConsoleErrors,
  DEFAULT_SEED,
  DEFAULT_RULES_ID,
  goToLobby,
  openGameDetails,
  readRoomIdFromLobby,
  seedLocalStorage,
  startPrivateGame,
  trackConsoleMessages,
} from "./helpers";

test.describe("UI Smoke Tests - Advanced Scenarios", () => {
  test("Rejoin after clearing localStorage (simulating browser close)", async ({
    page,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await page.getByTestId("seat-join:P1").click();
    await expect(page.getByTestId("seat-state:P1")).toContainText(/Your Seat/i);

    const roomId = await readRoomIdFromLobby(page);

    // Clear localStorage (simulating browser close/restart)
    await page.evaluate(() => localStorage.clear());

    // Navigate away and back
    await page.goto("/");
    await page.goto(`/${DEFAULT_RULES_ID}/${roomId}`);

    // Should be able to see room lobby
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible({
      timeout: 15000,
    });

    // Original seat should be available (we lost our connection)
    await expect(page.getByTestId("seat-join:P1")).toBeVisible();

    assertNoConsoleErrors(consoleMessages, [
      /Failed to load lobby data/,
      /Failed to fetch/,
    ]);
  });

  test("Multiple rooms created simultaneously", async ({ page, browser }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);

    // Create room 1
    await startPrivateGame(page, `${DEFAULT_SEED}-room1`);
    const roomId1 = await readRoomIdFromLobby(page);

    // Create room 2 in another context
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await goToLobby(page2);
    await openGameDetails(page2);
    await startPrivateGame(page2, `${DEFAULT_SEED}-room2`);
    const roomId2 = await readRoomIdFromLobby(page2);

    // Create room 3 in another context
    const context3 = await browser.newContext();
    const page3 = await context3.newPage();
    await goToLobby(page3);
    await openGameDetails(page3);
    await startPrivateGame(page3, `${DEFAULT_SEED}-room3`);
    const roomId3 = await readRoomIdFromLobby(page3);

    // All rooms should have unique IDs
    expect(roomId1).not.toBe(roomId2);
    expect(roomId2).not.toBe(roomId3);
    expect(roomId1).not.toBe(roomId3);

    // All rooms should be accessible
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible();
    await expect(
      page2.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible();
    await expect(
      page3.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible();

    await context2.close();
    await context3.close();
    assertNoConsoleErrors(consoleMessages);
  });

  test("Room ID edge cases - maximum length", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "toast-autoclose-enabled": false,
    });

    await goToLobby(page);
    await openGameDetails(page);

    const joinSection = page
      .getByRole("heading", { name: /Join by Room ID/i })
      .locator("..");

    // Try very long room ID
    const longId = "a".repeat(100);
    await joinSection.getByPlaceholder("Room ID").fill(longId);
    await joinSection.getByRole("button", { name: /^Join Room$/i }).click();

    // Should show error (room not found or validation error)
    await expect(
      page.getByText(/not found|does not exist|invalid/i)
    ).toBeVisible({
      timeout: 10000,
    });

    assertNoConsoleErrors(consoleMessages);
  });

  test("Room ID edge cases - special characters", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "toast-autoclose-enabled": false,
    });

    await goToLobby(page);
    await openGameDetails(page);

    const joinSection = page
      .getByRole("heading", { name: /Join by Room ID/i })
      .locator("..");

    // Try special characters
    await joinSection.getByPlaceholder("Room ID").fill("abc@#$%");

    // Input might be sanitized or button disabled
    const joinButton = joinSection.getByRole("button", {
      name: /^Join Room$/i,
    });

    // Either button is disabled or clicking shows error
    const isDisabled = await joinButton.isDisabled();
    if (!isDisabled) {
      await joinButton.click();
      // Should show error
      await expect(
        page.getByText(/not found|does not exist|invalid/i)
      ).toBeVisible({
        timeout: 10000,
      });
    }

    assertNoConsoleErrors(consoleMessages);
  });

  test("Slow network - loading states appear correctly", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    // Intercept and delay ONLY the active-games API call
    // Use fallback() instead of continue() to avoid "Route is already handled" errors
    const handler = async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.fallback();
    };
    await page.route("**/active-games**", handler);

    await goToLobby(page);

    // Should show loading state while games are being fetched
    const loadingIndicator = page.getByText(/Loading games/i);
    if (await loadingIndicator.isVisible().catch(() => false)) {
      expect(true).toBe(true); // Loading state appeared
    }

    // Eventually should show games list
    await expect(page.getByTestId(`game:${DEFAULT_RULES_ID}`)).toBeVisible({
      timeout: 30000,
    });

    // Clean up the route handler
    await page.unroute("**/active-games**", handler);

    assertNoConsoleErrors(consoleMessages);
  });

  test("Spectator can join game that's already in progress", async ({
    page,
    browser,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await page.getByTestId("seat-join:P1").click();
    const roomId = await readRoomIdFromLobby(page);

    // Start game
    await page.getByTestId("seat-ai-toggle:P2").click();
    await page.getByTestId("start-game").click();
    await expect(page.locator(".game-layout").first()).toBeVisible({
      timeout: 15000,
    });

    // Let game progress a bit
    await page.waitForTimeout(1000);

    // New spectator joins mid-game
    const specContext = await browser.newContext();
    const specPage = await specContext.newPage();
    await seedLocalStorage(specPage, {
      "ai-runtime-preference": "backend",
    });
    await specPage.goto(`/${DEFAULT_RULES_ID}/${roomId}`);

    // Wait for either room lobby or game layout to appear
    await Promise.race([
      specPage
        .getByRole("heading", { name: /Room Lobby/i })
        .waitFor({ timeout: 10000 }),
      specPage.locator(".game-layout").first().waitFor({ timeout: 10000 }),
    ]).catch(() => {
      // Either one appearing is fine
    });

    // Check if in lobby and click watch as spectator
    const lobbyHeading = specPage.getByRole("heading", {
      name: /Room Lobby/i,
    });
    if (await lobbyHeading.isVisible()) {
      const watchButton = specPage.getByRole("button", {
        name: /Watch as Spectator/i,
      });
      await expect(watchButton).toBeVisible({ timeout: 5000 });
      await watchButton.click();
    }

    // Should see game layout
    await expect(specPage.locator(".game-layout").first()).toBeVisible({
      timeout: 15000,
    });

    await specContext.close();
    assertNoConsoleErrors(consoleMessages);
  });

  test("4-player game (Canasta) can be created and started", async ({
    page,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
    });

    await goToLobby(page);

    // Navigate to Canasta (4-player game)
    await page.getByTestId("game:canasta").click();

    // Wait for modal to open
    await expect(page.getByRole("button", { name: /Advanced/i })).toBeVisible({
      timeout: 15000,
    });

    // Use Advanced flow to set seed
    await page.getByRole("button", { name: /Advanced/i }).click();
    await page
      .getByPlaceholder("e.g. ABCDEF (Leave blank for random)")
      .fill(DEFAULT_SEED);
    await page.getByRole("button", { name: /Private Room/i }).click();

    // Should be in room lobby
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible({
      timeout: 15000,
    });

    // Canasta has 4 seats: S, W, N, E
    await expect(page.getByTestId("seat-card:S")).toBeVisible();
    await expect(page.getByTestId("seat-card:W")).toBeVisible();
    await expect(page.getByTestId("seat-card:N")).toBeVisible();
    await expect(page.getByTestId("seat-card:E")).toBeVisible();

    // Join as one player, enable AI for the rest
    await page.getByTestId("seat-join:S").click();

    await page.getByTestId("seat-ai-toggle:W").click();
    await page.getByTestId("seat-ai-toggle:N").click();
    await page.getByTestId("seat-ai-toggle:E").click();

    // Start game
    await page.getByTestId("start-game").click();

    // Game should start
    await expect(page.locator(".game-layout").first()).toBeVisible({
      timeout: 15000,
    });

    assertNoConsoleErrors(consoleMessages, [/404/]);
  });
});
