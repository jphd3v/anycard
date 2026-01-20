import { test, expect } from "@playwright/test";
import {
  assertNoConsoleErrors,
  DEFAULT_SEED,
  goToLobby,
  openGameDetails,
  readRoomIdFromLobby,
  rejoinAsPlayer,
  seedLocalStorage,
  startPrivateGame,
  trackConsoleMessages,
} from "./helpers";

test.describe("UI Smoke Tests - Lobby Basics", () => {
  test("Home → game details sections", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);

    await expect(
      page.getByRole("heading", { name: /Join by Room ID/i })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Available Rooms/i })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Advanced/i })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Private Room/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Public Room/i })
    ).toBeVisible();

    assertNoConsoleErrors(consoleMessages);
  });

  test("Join by room ID", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);
    const roomId = await readRoomIdFromLobby(page);

    await page.getByRole("button", { name: /Back to game selection/i }).click();
    await expect(page.getByRole("button", { name: /Advanced/i })).toBeVisible();

    const joinSection = page
      .getByRole("heading", { name: /Join by Room ID/i })
      .locator("..");
    await joinSection.getByPlaceholder("Room ID").fill(roomId);
    await joinSection.getByRole("button", { name: /^Join Room$/i }).click();

    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(/Room Found/i)).toBeVisible();

    assertNoConsoleErrors(consoleMessages);
  });

  test("Room lobby AI toggle + spectator", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
      "toast-autoclose-enabled": false,
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await expect(page.getByTestId("seat-card:P1")).toBeVisible();

    const seatToggle = page.getByTestId("seat-ai-toggle:P1");
    await expect(seatToggle).toBeEnabled();
    await seatToggle.click();
    await expect(page.getByTestId("seat-state:P1")).toContainText(
      /AI Controlled/i
    );
    await expect(
      page.getByText(/You are not joined to this game/i)
    ).toHaveCount(0);

    await seatToggle.click();
    await expect(page.getByTestId("seat-join:P1")).toBeVisible();
    await expect(
      page.getByText(/You are not joined to this game/i)
    ).toHaveCount(0);

    await page.getByRole("button", { name: /Watch as Spectator/i }).click();
    await expect(
      page.getByText(/You are watching as a spectator/i)
    ).toBeVisible();

    assertNoConsoleErrors(consoleMessages);
  });

  test("Room lobby minimize + restore", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);
    await rejoinAsPlayer(page);

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

    assertNoConsoleErrors(consoleMessages);
  });
});
