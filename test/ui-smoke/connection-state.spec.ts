import { test, expect } from "@playwright/test";
import {
  assertNoConsoleErrors,
  DEFAULT_SEED,
  DEFAULT_RULES_ID,
  goToLobby,
  openGameDetails,
  readRoomIdFromLobby,
  rejoinAsPlayer,
  seedLocalStorage,
  simulateOffline,
  simulateOnline,
  startPrivateGame,
  trackConsoleMessages,
} from "./helpers";

test.describe("UI Smoke Tests - Connection State Management", () => {
  test("Browser refresh preserves seat", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);
    await page.getByTestId("seat-join:P1").click();

    await expect(page.getByTestId("seat-state:P1")).toContainText(/Your Seat/i);

    const roomId = await readRoomIdFromLobby(page);

    // Refresh browser
    await page.reload();

    // Should auto-rejoin and still have seat
    await expect(page.getByTestId("seat-state:P1")).toContainText(
      /Your Seat/i,
      { timeout: 15000 }
    );

    // Room ID should be the same
    expect(await readRoomIdFromLobby(page)).toBe(roomId);

    assertNoConsoleErrors(consoleMessages);
  });

  test("Browser refresh during game preserves seat and game state", async ({
    page,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);
    await rejoinAsPlayer(page);

    // Start game with AI
    const seatToggle = page.getByTestId("seat-ai-toggle:P2");
    await seatToggle.click();
    await page.getByTestId("start-game").click();
    await page.locator(".game-layout").first().waitFor();

    // Refresh browser
    await page.reload();

    // Should still be in game (not kicked back to lobby)
    await expect(page.locator(".game-layout").first()).toBeVisible({
      timeout: 15000,
    });

    // Should not show "Room Lobby" (we're in the game)
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toHaveCount(0);

    assertNoConsoleErrors(consoleMessages);
  });

  test("Network disconnect shows reconnecting overlay", async ({
    page,
    context,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);
    await rejoinAsPlayer(page);

    // Simulate network offline
    await simulateOffline(page, context);

    // Should show reconnecting overlay within a few seconds
    await expect(page.getByText(/Reconnecting/i).first()).toBeVisible({
      timeout: 10000,
    });

    // Should NOT redirect to lobby or show errors yet
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible();

    assertNoConsoleErrors(consoleMessages, [/ERR_INTERNET_DISCONNECTED/]);
  });

  test("Network reconnect restores connection and preserves seat", async ({
    page,
    context,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);
    await rejoinAsPlayer(page);

    // Simulate network offline
    await simulateOffline(page, context);

    await expect(page.getByText(/Reconnecting/i).first()).toBeVisible({
      timeout: 10000,
    });

    // Restore network
    await simulateOnline(page, context);

    // Should reconnect and hide overlay
    await expect(page.getByText(/Reconnecting/i).first()).toHaveCount(0, {
      timeout: 15000,
    });

    // Should still be in room lobby with seat
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible();
    await expect(page.getByTestId("seat-state:P1")).toContainText(/Your Seat/i);

    assertNoConsoleErrors(consoleMessages, [/ERR_INTERNET_DISCONNECTED/]);
  });

  test("Network disconnect during game preserves game state on reconnect", async ({
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
    await rejoinAsPlayer(page);

    const seatToggle = page.getByTestId("seat-ai-toggle:P2");
    await seatToggle.click();
    await page.getByTestId("start-game").click();
    await page.locator(".game-layout").first().waitFor();

    // Disconnect network
    await simulateOffline(page, context);

    await expect(page.getByText(/Reconnecting/i).first()).toBeVisible({
      timeout: 10000,
    });

    // Reconnect
    await simulateOnline(page, context);

    // Should hide overlay and still be in game
    await expect(page.getByText(/Reconnecting/i).first()).toHaveCount(0, {
      timeout: 15000,
    });
    await expect(page.locator(".game-layout").first()).toBeVisible();

    assertNoConsoleErrors(consoleMessages, [/ERR_INTERNET_DISCONNECTED/]);
  });

  test("Game not found (404) shows error screen, not stale UI", async ({
    page,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    const fakeGameId = "NOTEXIST";

    await page.goto(`/${DEFAULT_RULES_ID}/${fakeGameId}`);

    // Should show error screen or redirect to lobby
    // Should NOT show:
    // - "Reconnecting..." indefinitely
    // - Stale game UI
    // - Room Lobby for non-existent game

    await Promise.race([
      // Either shows error message
      page.getByText(/Game Not Found|not available|not found/i).waitFor({
        timeout: 15000,
      }),
      // Or redirects to lobby
      page
        .getByRole("heading", { name: /AnyCard/i })
        .waitFor({ timeout: 15000 }),
    ]);

    // Should NOT be stuck on "Reconnecting..."
    const reconnectingVisible = await page
      .getByText(/Reconnecting/i)
      .first()
      .isVisible()
      .catch(() => false);
    expect(reconnectingVisible).toBe(false);

    assertNoConsoleErrors(consoleMessages);
  });

  test("Navigating to deleted game shows error, not stale state", async ({
    page,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "toast-autoclose-enabled": false,
    });

    // Create game
    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    // Leave game
    await page.getByRole("button", { name: /Back to game selection/i }).click();
    await expect(page.getByRole("heading", { name: /AnyCard/i })).toBeVisible();

    // Wait for game to close (demo rooms close after 30 seconds, but we can't wait that long)
    // Instead, navigate to a known non-existent game ID
    const fakeGameId = "FAKEGAME";

    await page.goto(`/${DEFAULT_RULES_ID}/${fakeGameId}`);

    // Should show error or redirect to lobby
    await Promise.race([
      page.getByText(/Game Not Found|not available|not found/i).waitFor({
        timeout: 15000,
      }),
      page
        .getByRole("heading", { name: /AnyCard/i })
        .waitFor({ timeout: 15000 }),
    ]);

    // Should NOT show:
    // - Room Lobby UI with stale data
    // - Player seated in non-existent game
    const roomLobbyVisible = await page
      .getByRole("heading", { name: /Room Lobby/i })
      .isVisible()
      .catch(() => false);

    if (roomLobbyVisible) {
      // If Room Lobby is shown, it should indicate error state
      await expect(
        page.getByText(/not found|not available|error/i)
      ).toBeVisible();
    }

    assertNoConsoleErrors(consoleMessages, [/Failed to fetch/]);
  });

  test("Can leave game and return to lobby", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);
    await rejoinAsPlayer(page);

    // Should be in room lobby as a player
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible();
    await expect(page.getByTestId("seat-state:P1")).toContainText(/Your Seat/i);

    // Leave game and return to main lobby
    await page.getByRole("button", { name: /Back to game selection/i }).click();
    await expect(page.getByRole("heading", { name: /AnyCard/i })).toBeVisible({
      timeout: 10000,
    });

    // Verify we're back at the lobby and UI is functional
    await expect(page.getByTestId(`game:${DEFAULT_RULES_ID}`)).toBeVisible();

    assertNoConsoleErrors(consoleMessages);
  });

  test("Seat cannot be stolen by different player", async ({
    page,
    browser,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, { "player-id": "player-1" });
    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await page.getByTestId("seat-join:P1").click();
    await expect(page.getByTestId("seat-state:P1")).toContainText(/Your Seat/i);

    const roomId = await readRoomIdFromLobby(page);

    // Open same game in new browser context (different player)
    const newContext = await browser.newContext();
    const newPage = await newContext.newPage();
    await seedLocalStorage(newPage, { "player-id": "player-2" });
    await newPage.goto(`/${DEFAULT_RULES_ID}/${roomId}`);

    await newPage
      .getByRole("heading", { name: /Room Lobby/i })
      .waitFor({ timeout: 15000 });

    // P1 seat should NOT be joinable
    const p1JoinButton = newPage.getByTestId("seat-join:P1");
    await expect(p1JoinButton).toHaveCount(0);

    // P1 should show as occupied
    await expect(newPage.getByTestId("seat-state:P1")).toContainText(
      /Occupied/i
    );

    // P2 seat should be available
    await expect(newPage.getByTestId("seat-join:P2")).toBeVisible();

    await newContext.close();
    assertNoConsoleErrors(consoleMessages);
  });

  test("Same player opening new tab sees seat as occupied", async ({
    page,
    browser,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    const playerId = "same-player-test";

    await seedLocalStorage(page, { "player-id": playerId });
    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);
    await page.getByTestId("seat-join:P1").click();

    // Read room ID for new tab navigation
    const roomId = await readRoomIdFromLobby(page);

    // Open new tab with same player ID
    const newPage = await browser.newPage();
    await seedLocalStorage(newPage, { "player-id": playerId });
    await newPage.goto(`/${DEFAULT_RULES_ID}/${roomId}`);

    // New tab should see seat as occupied (multi-tab not supported)
    // The socket from the first tab holds the seat
    await expect(newPage.getByTestId("seat-state:P1")).toContainText(
      /Occupied/i,
      { timeout: 15000 }
    );

    // First tab should still show as seated
    await expect(page.getByTestId("seat-state:P1")).toContainText(/Your Seat/i);

    await newPage.close();
    assertNoConsoleErrors(consoleMessages);
  });

  test("Disconnection in lobby shows reconnecting overlay", async ({
    page,
    context,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);

    // Disconnect
    await simulateOffline(page, context);

    // Should show reconnecting overlay
    await expect(page.getByText(/Reconnecting/i).first()).toBeVisible({
      timeout: 10000,
    });

    // Reconnect
    await simulateOnline(page, context);

    // Should hide overlay and still be in lobby
    await expect(page.getByText(/Reconnecting/i).first()).toHaveCount(0, {
      timeout: 15000,
    });
    await expect(page.getByRole("heading", { name: /AnyCard/i })).toBeVisible();

    assertNoConsoleErrors(consoleMessages, [
      /ERR_INTERNET_DISCONNECTED/,
      /Failed to fetch/,
      /Failed to load/,
    ]);
  });

  test("Disconnection during game recovers gracefully on reconnect", async ({
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
    await rejoinAsPlayer(page);

    const seatToggle = page.getByTestId("seat-ai-toggle:P2");
    await seatToggle.click();
    await page.getByTestId("start-game").click();
    await page.locator(".game-layout").first().waitFor();

    // Disconnect for extended period
    await simulateOffline(page, context);

    await expect(page.getByText(/Reconnecting/i).first()).toBeVisible({
      timeout: 10000,
    });

    // Wait a few seconds (simulating disconnection)
    await page.waitForTimeout(2000);

    // Should still show reconnecting (because network is still offline)
    await expect(page.getByText(/Reconnecting/i).first()).toBeVisible();

    // Reconnect
    await simulateOnline(page, context);

    // After reconnect, should either:
    // 1. Rejoin successfully (game still exists)
    // 2. Show error/redirect (game was closed)

    await expect(page.getByText(/Reconnecting/i).first()).toHaveCount(0, {
      timeout: 15000,
    });

    // Should be in SOME valid state (not stuck)
    const inGame = await page
      .locator(".game-layout")
      .first()
      .isVisible()
      .catch(() => false);
    const inLobby = await page
      .getByRole("heading", { name: /AnyCard/i })
      .isVisible()
      .catch(() => false);
    const inRoomLobby = await page
      .getByRole("heading", { name: /Room Lobby/i })
      .isVisible()
      .catch(() => false);

    expect(inGame || inLobby || inRoomLobby).toBe(true);

    assertNoConsoleErrors(consoleMessages, [/ERR_INTERNET_DISCONNECTED/]);
  });

  test("Rapid disconnect/reconnect cycles are handled gracefully", async ({
    page,
    context,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);
    await rejoinAsPlayer(page);

    // Rapid disconnect/reconnect cycles (2 cycles to test stability)
    for (let i = 0; i < 2; i++) {
      await simulateOffline(page, context);
      await page.waitForTimeout(500);
      await simulateOnline(page, context);
      await page.waitForTimeout(500);
    }

    // Should eventually stabilize and be in valid state
    await page.waitForTimeout(2000);

    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible();
    await expect(page.getByTestId("seat-state:P1")).toContainText(/Your Seat/i);

    assertNoConsoleErrors(consoleMessages, [/ERR_INTERNET_DISCONNECTED/]);
  });

  test("AI-controlled seat cannot be joined by human", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
      "toast-autoclose-enabled": false,
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    // Enable AI for P1
    const seatToggle = page.getByTestId("seat-ai-toggle:P1");
    await seatToggle.click();

    // Join button should disappear
    await expect(page.getByTestId("seat-join:P1")).toHaveCount(0);

    // Seat should show as AI Controlled
    await expect(page.getByTestId("seat-state:P1")).toContainText(
      /AI Controlled/i
    );

    assertNoConsoleErrors(consoleMessages);
  });

  test("Player can leave seat and rejoin", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await page.getByTestId("seat-join:P1").click();
    await expect(page.getByTestId("seat-state:P1")).toContainText(/Your Seat/i);

    // Leave by joining as spectator
    await page.getByRole("button", { name: /Watch as Spectator/i }).click();
    await expect(
      page.getByText(/You are watching as a spectator/i)
    ).toBeVisible();

    // P1 should now be available
    await expect(page.getByTestId("seat-join:P1")).toBeVisible();

    // Rejoin P1
    await page.getByTestId("seat-join:P1").click();
    await expect(page.getByTestId("seat-state:P1")).toContainText(/Your Seat/i);

    assertNoConsoleErrors(consoleMessages);
  });

  test("Page visibility wake-up maintains connection", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);
    await rejoinAsPlayer(page);

    // Simulate page hidden (tab backgrounded)
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        value: true,
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await page.waitForTimeout(2000);

    // Wake up page
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        value: false,
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Should still be connected and in room
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible();
    await expect(page.getByTestId("seat-state:P1")).toContainText(/Your Seat/i);

    assertNoConsoleErrors(consoleMessages);
  });

  test("Starting new game during disconnection works after reconnection", async ({
    page,
    context,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);

    // Disconnect
    await simulateOffline(page, context);

    // Should show reconnecting overlay
    await expect(page.getByText(/Reconnecting/i).first()).toBeVisible({
      timeout: 10000,
    });

    // Reconnect
    await simulateOnline(page, context);

    // Should reconnect and hide overlay
    await expect(page.getByText(/Reconnecting/i).first()).toHaveCount(0, {
      timeout: 15000,
    });

    // Now open game details - should work normally after reconnection
    await openGameDetails(page);

    // Now start game - should work normally
    await startPrivateGame(page, `disconnect-${Date.now()}`);

    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible({
      timeout: 15000,
    });

    assertNoConsoleErrors(consoleMessages, [/ERR_INTERNET_DISCONNECTED/]);
  });

  test("Joining existing game during disconnection queues until reconnection", async ({
    page,
    browser,
    context,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    // Create a game first
    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    const roomId = await readRoomIdFromLobby(page);

    // Open new browser context
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();

    await goToLobby(otherPage);

    // Disconnect the new page
    await otherContext.setOffline(true);

    // Should show reconnecting
    await expect(otherPage.getByText(/Reconnecting/i).first()).toBeVisible({
      timeout: 10000,
    });

    // Try to navigate to game (this will queue)
    const navigationPromise = otherPage
      .goto(`/${DEFAULT_RULES_ID}/${roomId}`)
      .catch(() => {});

    // Reconnect
    await otherContext.setOffline(false);

    // Should reconnect and load game
    await expect(otherPage.getByText(/Reconnecting/i).first()).toHaveCount(0, {
      timeout: 15000,
    });

    // Wait for the queued navigation to complete after reconnection
    await navigationPromise;

    // If the browser showed an error page (e.g. Chrome's "No Internet"), it might not auto-reload.
    // We check if we are on the right page, and if not, reload.
    try {
      await expect(
        otherPage.getByRole("heading", { name: /Room Lobby/i })
      ).toBeVisible({ timeout: 5000 });
    } catch {
      await otherPage.reload();
      await expect(
        otherPage.getByRole("heading", { name: /Room Lobby/i })
      ).toBeVisible({ timeout: 20000 });
    }

    await otherContext.close();
    assertNoConsoleErrors(consoleMessages);
  });

  test("Can disconnect and reconnect while in game creation modal", async ({
    page,
    context,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);

    // Start filling out game creation form
    await page.getByRole("button", { name: /Advanced/i }).click();
    await page
      .getByPlaceholder("e.g. ABCDEF (Leave blank for random)")
      .fill(DEFAULT_SEED);

    // Disconnect
    await simulateOffline(page, context);

    // Should show reconnecting overlay
    await expect(page.getByText(/Reconnecting/i).first()).toBeVisible({
      timeout: 10000,
    });

    // Reconnect
    await simulateOnline(page, context);

    // Should reconnect and overlay should disappear
    await expect(page.getByText(/Reconnecting/i).first()).toHaveCount(0, {
      timeout: 15000,
    });

    // Should still be in the modal with form filled
    await expect(
      page.getByRole("button", { name: /Private Room/i })
    ).toBeVisible({
      timeout: 15000,
    });

    // Should be able to create game after reconnection
    await page.getByRole("button", { name: /Private Room/i }).click();
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible({ timeout: 15000 });

    assertNoConsoleErrors(consoleMessages, [/ERR_INTERNET_DISCONNECTED/]);
  });

  test("Can navigate back to lobby after disconnection and reconnection", async ({
    page,
    context,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);
    await rejoinAsPlayer(page);

    // Should be in room lobby
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible();

    // Disconnect
    await simulateOffline(page, context);

    await expect(page.getByText(/Reconnecting/i).first()).toBeVisible({
      timeout: 10000,
    });

    // Reconnect (can't click while disconnected - overlay blocks it)
    await simulateOnline(page, context);

    // Should reconnect
    await expect(page.getByText(/Reconnecting/i).first()).toHaveCount(0, {
      timeout: 15000,
    });

    // Now can navigate back to lobby after reconnection
    await page.getByRole("button", { name: /Back to game selection/i }).click();

    // Should successfully return to lobby
    await expect(page.getByRole("heading", { name: /AnyCard/i })).toBeVisible({
      timeout: 10000,
    });

    // Verify lobby UI is functional
    await expect(page.getByTestId(`game:${DEFAULT_RULES_ID}`)).toBeVisible();

    assertNoConsoleErrors(consoleMessages, [/ERR_INTERNET_DISCONNECTED/]);
  });
});
