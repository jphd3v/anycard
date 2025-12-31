import { test, expect } from "@playwright/test";
import {
  assertNoConsoleErrors,
  DEFAULT_SEED,
  goToLobby,
  openGameDetails,
  rejoinAsPlayer,
  seedLocalStorage,
  startPrivateGame,
  trackConsoleMessages,
} from "./helpers";

test.describe("UI Smoke Tests - Join Seat Flow", () => {
  test("Start game → join seat → exit to lobby", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
    });

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);
    await rejoinAsPlayer(page);

    const seatToggle = page.getByTestId("seat-ai-toggle:P2");
    await expect(seatToggle).toBeEnabled();
    await seatToggle.click();
    await expect(page.getByTestId("start-game")).toBeVisible();
    await page.getByTestId("start-game").click();
    await expect(page.getByTestId("start-game")).toHaveCount(0);

    await page.getByRole("button", { name: /Menu/i }).click();
    await page.getByRole("button", { name: /^Exit$/i }).click({ force: true });
    await expect(
      page.getByRole("dialog", { name: /Exit to room lobby/i })
    ).toBeVisible();
    await page.getByRole("button", { name: /Exit to Lobby/i }).click();
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible();

    assertNoConsoleErrors(consoleMessages);
  });
});
