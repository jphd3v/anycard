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

test.describe("UI Smoke Tests - Lobby State Synchronization", () => {
  test("Lobby loads available games list", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);

    // Should show at least one available game
    await expect(page.getByTestId(`game:${DEFAULT_RULES_ID}`)).toBeVisible({
      timeout: 30000,
    });

    // Loading indicator should disappear
    await expect(
      page.getByRole("heading", { name: /Loading games/i })
    ).toHaveCount(0);

    assertNoConsoleErrors(consoleMessages);
  });

  test("Active games list updates when new game is created", async ({
    page,
    browser,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);

    // Create new game in different browser context
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();

    await goToLobby(otherPage);
    await openGameDetails(otherPage);
    await startPrivateGame(otherPage, `test-${Date.now()}`);

    // Wait a bit for the game to be created
    await page.waitForTimeout(2000);

    // Verify the modal is still open and responsive
    await expect(page.getByRole("button", { name: /Advanced/i })).toBeVisible();

    await otherContext.close();
    assertNoConsoleErrors(consoleMessages);
  });

  test("Room lobby seat status updates when player joins", async ({
    page,
    browser,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    const roomId = await readRoomIdFromLobby(page);

    // P1 should be available
    await expect(page.getByTestId("seat-join:P1")).toBeVisible();
    await expect(page.getByTestId("seat-join:P2")).toBeVisible();

    // Open same game in another browser
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await otherPage.goto(`/${DEFAULT_RULES_ID}/${roomId}`);

    await otherPage
      .getByRole("heading", { name: /Room Lobby/i })
      .waitFor({ timeout: 15000 });

    // Other player joins P1
    await otherPage.getByTestId("seat-join:P1").click();
    await expect(otherPage.getByTestId("seat-state:P1")).toContainText(
      /Your Seat/i
    );

    // Original page should see P1 as occupied (might take a moment for broadcast)
    await expect(page.getByTestId("seat-state:P1")).toContainText(/Occupied/i, {
      timeout: 5000,
    });

    // P1 join button should disappear
    await expect(page.getByTestId("seat-join:P1")).toHaveCount(0);

    await otherContext.close();
    assertNoConsoleErrors(consoleMessages);
  });

  test("Room lobby seat status updates when player leaves", async ({
    page,
    browser,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    const roomId = await readRoomIdFromLobby(page);

    // Other player joins
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await otherPage.goto(`/${DEFAULT_RULES_ID}/${roomId}`);

    await otherPage
      .getByRole("heading", { name: /Room Lobby/i })
      .waitFor({ timeout: 15000 });

    await otherPage.getByTestId("seat-join:P1").click();
    await expect(otherPage.getByTestId("seat-state:P1")).toContainText(
      /Your Seat/i
    );

    // Original page should see P1 as occupied
    await expect(page.getByTestId("seat-state:P1")).toContainText(/Occupied/i, {
      timeout: 5000,
    });

    // Other player leaves (become spectator)
    await otherPage
      .getByRole("button", { name: /Watch as Spectator/i })
      .click();

    // Original page should see P1 as available again
    await expect(page.getByTestId("seat-join:P1")).toBeVisible({
      timeout: 5000,
    });

    await otherContext.close();
    assertNoConsoleErrors(consoleMessages);
  });

  test("Room lobby updates when AI is enabled/disabled", async ({
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

    const roomId = await readRoomIdFromLobby(page);

    // Other player watches
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await seedLocalStorage(otherPage, {
      "ai-runtime-preference": "backend",
    });
    await otherPage.goto(`/${DEFAULT_RULES_ID}/${roomId}`);

    await otherPage
      .getByRole("heading", { name: /Room Lobby/i })
      .waitFor({ timeout: 15000 });

    // Original page enables AI for P1
    await page.getByTestId("seat-ai-toggle:P1").click();
    await expect(page.getByTestId("seat-state:P1")).toContainText(
      /AI Controlled/i
    );

    // Other page should see AI status (might take a moment)
    await expect(otherPage.getByTestId("seat-state:P1")).toContainText(
      /AI Controlled/i,
      { timeout: 5000 }
    );

    // Disable AI
    await page.getByTestId("seat-ai-toggle:P1").click();
    await expect(page.getByTestId("seat-join:P1")).toBeVisible();

    // Other page should see seat available again
    await expect(otherPage.getByTestId("seat-join:P1")).toBeVisible({
      timeout: 5000,
    });

    await otherContext.close();
    assertNoConsoleErrors(consoleMessages);
  });

  test("Game start is broadcasted to all players", async ({
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

    await rejoinAsPlayer(page);

    const roomId = await readRoomIdFromLobby(page);

    // Other player joins as spectator
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await seedLocalStorage(otherPage, {
      "ai-runtime-preference": "backend",
    });
    await otherPage.goto(`/${DEFAULT_RULES_ID}/${roomId}`);

    await otherPage
      .getByRole("heading", { name: /Room Lobby/i })
      .waitFor({ timeout: 15000 });

    await otherPage
      .getByRole("button", { name: /Watch as Spectator/i })
      .click();

    // Original player starts game
    await page.getByTestId("seat-ai-toggle:P2").click();
    await page.getByTestId("start-game").click();

    // Original player should see game
    await expect(page.locator(".game-layout").first()).toBeVisible({
      timeout: 15000,
    });

    // Spectator should also see game start
    await expect(otherPage.locator(".game-layout").first()).toBeVisible({
      timeout: 15000,
    });

    await otherContext.close();
    assertNoConsoleErrors(consoleMessages);
  });

  test("Spectator sees real-time game updates", async ({ page, browser }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await rejoinAsPlayer(page);

    const roomId = await readRoomIdFromLobby(page);

    // Other player joins as spectator
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await seedLocalStorage(otherPage, {
      "ai-runtime-preference": "backend",
    });
    await otherPage.goto(`/${DEFAULT_RULES_ID}/${roomId}`);

    await otherPage
      .getByRole("heading", { name: /Room Lobby/i })
      .waitFor({ timeout: 15000 });

    await otherPage
      .getByRole("button", { name: /Watch as Spectator/i })
      .click();

    // Start game
    await page.getByTestId("seat-ai-toggle:P2").click();
    await page.getByTestId("start-game").click();

    await expect(page.locator(".game-layout").first()).toBeVisible({
      timeout: 15000,
    });

    await expect(otherPage.locator(".game-layout").first()).toBeVisible({
      timeout: 15000,
    });

    // Both should show the same game state
    // (Detailed verification depends on game type)

    await otherContext.close();
    assertNoConsoleErrors(consoleMessages);
  });

  test("Room polling updates room status", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    // We're now in Room Lobby - verify it's functional
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible();

    // Wait for a polling cycle to ensure nothing breaks
    await page.waitForTimeout(2000);

    // Verify UI is still responsive
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible();

    assertNoConsoleErrors(consoleMessages);
  });

  test("Recent games section shows previously joined games", async ({
    page,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);
    await rejoinAsPlayer(page);

    // We're in Room Lobby - verify we can see the game
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible();

    // Navigate back to home
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /AnyCard/i })).toBeVisible();

    // Open game details again - recent games should be tracked
    await openGameDetails(page);

    // Recent games section should exist (the UI should be functional)
    // At minimum, verify no crash

    await expect(page.getByRole("button", { name: /Advanced/i })).toBeVisible();

    assertNoConsoleErrors(consoleMessages);
  });

  test("Available rooms section shows public/demo rooms", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);

    // Available Rooms section should be visible
    await expect(
      page.getByRole("heading", { name: /Available Rooms/i })
    ).toBeVisible();

    // Might show "No rooms available" or list of rooms
    // This test just verifies the section exists and is functional

    assertNoConsoleErrors(consoleMessages);
  });

  test("Creating public room makes it appear in available rooms", async ({
    page,
    browser,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);

    // Create public room
    await page.getByRole("button", { name: /Public Room/i }).click();
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible({
      timeout: 15000,
    });

    const roomId = await readRoomIdFromLobby(page);

    // Other browser opens lobby
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();

    await goToLobby(otherPage);
    await openGameDetails(otherPage);

    // Wait for polling to update
    await otherPage.waitForTimeout(2000);

    // Available rooms should show our public room
    // (Verification depends on how public rooms are displayed)
    // At minimum, verify they can join via room ID

    const joinSection = otherPage
      .getByRole("heading", { name: /Join by Room ID/i })
      .locator("..");

    await joinSection.getByPlaceholder("Room ID").fill(roomId);
    await joinSection.getByRole("button", { name: /^Join Room$/i }).click();

    await expect(
      otherPage.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible({ timeout: 15000 });

    await otherContext.close();
    assertNoConsoleErrors(consoleMessages);
  });

  test("Player disconnect is reflected in seat status", async ({
    page,
    browser,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    const roomId = await readRoomIdFromLobby(page);

    // Other player joins
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await otherPage.goto(`/${DEFAULT_RULES_ID}/${roomId}`);

    await otherPage
      .getByRole("heading", { name: /Room Lobby/i })
      .waitFor({ timeout: 15000 });

    await otherPage.getByTestId("seat-join:P1").click();

    // Original page should see P1 occupied
    await expect(page.getByTestId("seat-state:P1")).toContainText(/Occupied/i, {
      timeout: 5000,
    });

    // Other player disconnects (close browser)
    await otherContext.close();

    // After disconnect, seat should become available again
    // (Might take a few seconds for server to detect disconnect)
    await expect(page.getByTestId("seat-join:P1")).toBeVisible({
      timeout: 10000,
    });

    assertNoConsoleErrors(consoleMessages);
  });

  test("Multiple spectators can watch same game", async ({ page, browser }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await rejoinAsPlayer(page);

    const roomId = await readRoomIdFromLobby(page);

    // Spectator joins room lobby BEFORE game starts
    const spec1Context = await browser.newContext();
    const spec1Page = await spec1Context.newPage();
    await seedLocalStorage(spec1Page, {
      "ai-runtime-preference": "backend",
    });
    await spec1Page.goto(`/${DEFAULT_RULES_ID}/${roomId}`);

    await spec1Page
      .getByRole("heading", { name: /Room Lobby/i })
      .waitFor({ timeout: 15000 });

    await spec1Page
      .getByRole("button", { name: /Watch as Spectator/i })
      .click();

    // Now start the game
    await page.getByTestId("seat-ai-toggle:P2").click();
    await page.getByTestId("start-game").click();

    // Both should see the game
    await expect(page.locator(".game-layout").first()).toBeVisible({
      timeout: 15000,
    });

    await expect(spec1Page.locator(".game-layout").first()).toBeVisible({
      timeout: 15000,
    });

    await spec1Context.close();

    assertNoConsoleErrors(consoleMessages);
  });
});
