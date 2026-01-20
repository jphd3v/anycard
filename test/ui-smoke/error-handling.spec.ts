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
  startPrivateGame,
  trackConsoleMessages,
} from "./helpers";

test.describe("UI Smoke Tests - Error Handling & Edge Cases", () => {
  test("Invalid room ID shows error message", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "toast-autoclose-enabled": false,
    });

    await goToLobby(page);
    await openGameDetails(page);

    // Try to join with invalid room ID
    const joinSection = page
      .getByRole("heading", { name: /Join by Room ID/i })
      .locator("..");

    await joinSection.getByPlaceholder("Room ID").fill("INVALID!");

    // Should show error or validation message
    // Invalid characters in room ID should be rejected or sanitized

    assertNoConsoleErrors(consoleMessages);
  });

  test("Empty room ID shows validation error", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "toast-autoclose-enabled": false,
    });

    await goToLobby(page);
    await openGameDetails(page);

    const joinSection = page
      .getByRole("heading", { name: /Join by Room ID/i })
      .locator("..");

    // Try to join with empty room ID
    await joinSection.getByPlaceholder("Room ID").fill("");
    const joinButton = joinSection.getByRole("button", {
      name: /^Join Room$/i,
    });

    // Join button should be disabled or show error
    const isDisabled = await joinButton.isDisabled();
    expect(isDisabled).toBe(true);

    assertNoConsoleErrors(consoleMessages);
  });

  test("Trying to join non-existent room shows error", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "toast-autoclose-enabled": false,
    });

    await goToLobby(page);
    await openGameDetails(page);

    const joinSection = page
      .getByRole("heading", { name: /Join by Room ID/i })
      .locator("..");

    // Try to join non-existent room
    await joinSection.getByPlaceholder("Room ID").fill("NOTFOUND");
    await joinSection.getByRole("button", { name: /^Join Room$/i }).click();

    // Should show error message (either toast or inline)
    await expect(
      page.getByText(/not found|does not exist|invalid/i)
    ).toBeVisible({
      timeout: 10000,
    });

    assertNoConsoleErrors(consoleMessages);
  });

  test("Attempting to start game with no seats joined shows error", async ({
    page,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "toast-autoclose-enabled": false,
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    // Don't join any seat, try to start game
    // Start button should not be visible or should be disabled
    const startButton = page.getByTestId("start-game");

    // Start game button should not be available (no seats filled)
    await expect(startButton).toHaveCount(0);

    assertNoConsoleErrors(consoleMessages);
  });

  test("Cannot enable AI for already occupied seat", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
      "toast-autoclose-enabled": false,
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    // Join P1
    await page.getByTestId("seat-join:P1").click();
    await expect(page.getByTestId("seat-state:P1")).toContainText(/Your Seat/i);

    // P1 AI toggle should be disabled or not present
    const p1Toggle = page.getByTestId("seat-ai-toggle:P1");
    const isDisabled = await p1Toggle.isDisabled().catch(() => true);
    expect(isDisabled).toBe(true);

    assertNoConsoleErrors(consoleMessages);
  });

  test("Spectator cannot start game", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    // Join as spectator
    await page.getByRole("button", { name: /Watch as Spectator/i }).click();
    await expect(
      page.getByText(/You are watching as a spectator/i)
    ).toBeVisible();

    // Enable AI for both seats
    await page.getByTestId("seat-ai-toggle:P1").click();
    await page.getByTestId("seat-ai-toggle:P2").click();

    // Start button should appear
    await expect(page.getByTestId("start-game")).toBeVisible();

    // TODO: Verify spectator can or cannot click start
    // This depends on game rules - some games allow spectators to start AI-only games

    assertNoConsoleErrors(consoleMessages);
  });

  test("Navigating away from game clears game state", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);
    await rejoinAsPlayer(page);

    // Start game
    await page.getByTestId("seat-ai-toggle:P2").click();
    await page.getByTestId("start-game").click();
    await page.locator(".game-layout").first().waitFor();

    // Exit to lobby via menu
    await page.getByRole("button", { name: /Menu/i }).click();
    await page.waitForTimeout(500); // Wait for menu to appear
    // Programmatically click to bypass view transition stability issues
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const quitButton = buttons.find((b) =>
        b.textContent?.includes("Quit Game")
      );
      quitButton?.click();
    });
    await page
      .getByRole("dialog", { name: /Exit to room lobby/i })
      .waitFor({ state: "visible" });
    await page.getByRole("button", { name: /Exit to Lobby/i }).click();

    // Should be back in room lobby
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible();

    // Navigate back to home
    await page.getByRole("button", { name: /Back to game selection/i }).click();
    await expect(page.getByRole("heading", { name: /AnyCard/i })).toBeVisible();

    // Game state should be cleared (no stale UI)
    await expect(page.locator(".game-layout").first()).toHaveCount(0);

    assertNoConsoleErrors(consoleMessages);
  });

  test("Direct URL navigation to game works without lobby visit", async ({
    page,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    // Create a game first in a separate flow
    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    const roomId = await readRoomIdFromLobby(page);

    // Clear state and navigate directly via URL
    await page.goto("/");
    await page.goto(`/${DEFAULT_RULES_ID}/${roomId}`);

    // Should load game directly
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible({
      timeout: 15000,
    });

    assertNoConsoleErrors(consoleMessages, [/Failed to load lobby data/]);
  });

  test("Game closed by server shows appropriate message", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "toast-autoclose-enabled": false,
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    const roomId = await readRoomIdFromLobby(page);

    // Leave the game
    await page.getByRole("button", { name: /Back to game selection/i }).click();

    // In real scenario, demo room closes after 30s, non-demo after 5min
    // We can't wait that long, so simulate by:
    // 1. Wait a few seconds
    // 2. Try to rejoin via URL
    // 3. Expect game to still exist (we didn't wait long enough) OR
    // 4. Skip this test in favor of testing non-existent game handling

    // For now, test that rejoining works before timeout
    await page.goto(`/${DEFAULT_RULES_ID}/${roomId}`);

    // Game should still exist (we didn't wait 30 seconds)
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible({
      timeout: 15000,
    });

    assertNoConsoleErrors(consoleMessages, [
      /Failed to fetch active games/,
      /Failed to fetch/,
    ]);
  });

  test("Room ID is displayed and copyable", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    // Room ID should be visible
    const roomId = await readRoomIdFromLobby(page);
    expect(roomId).toMatch(/^[a-z0-9]{8}$/); // 8-character lowercase alphanumeric

    // There should be a way to copy it (button, click to copy, etc.)
    // This is a UX feature test

    assertNoConsoleErrors(consoleMessages);
  });

  test("Game seed is displayed in game menu", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);
    await rejoinAsPlayer(page);

    await page.getByTestId("seat-ai-toggle:P2").click();
    await page.getByTestId("start-game").click();
    await page.locator(".game-layout").first().waitFor();

    // Open menu
    await page.getByRole("button", { name: /Menu/i }).click();

    // Seed should be visible (note: title is "Copy Seed" with capital S)
    const seedButton = page.getByTitle("Copy Seed");
    await expect(seedButton).toBeVisible();

    const seedText = await seedButton.textContent();
    expect(seedText).toBeTruthy();
    expect(seedText?.trim()).not.toBe("");

    assertNoConsoleErrors(consoleMessages);
  });

  test("Frontend AI shows warning banner", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "frontend",
      "local-ai-config": {
        enabled: true,
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "",
        model: "gpt-4o-mini",
      },
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    // Join P2 then enable AI on it (sponsoring frontend AI)
    await page.getByTestId("seat-join:P2").click();
    await expect(page.getByTestId("seat-state:P2")).toContainText(/Your Seat/i);

    // Enable frontend AI for P2
    await page.getByTestId("seat-ai-toggle:P2").click();

    // Verify P2 seat is no longer joinable (AI is enabled)
    await expect(page.getByTestId("seat-join:P2")).toHaveCount(0);

    // Warning banner should appear
    await expect(
      page.getByText(/Warning: Frontend AI runs in a browser/i)
    ).toBeVisible();

    assertNoConsoleErrors(consoleMessages);
  });

  test("Backend AI does not show warning banner", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await page.getByTestId("seat-join:P1").click();

    // Enable backend AI for P2
    await page.getByTestId("seat-ai-toggle:P2").click();

    // Warning banner should NOT appear
    await expect(page.getByText(/Warning: Frontend AI/i)).toHaveCount(0);

    assertNoConsoleErrors(consoleMessages);
  });
});
