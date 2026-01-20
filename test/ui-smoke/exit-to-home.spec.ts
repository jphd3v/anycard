import { test, expect } from "@playwright/test";
import {
  assertNoConsoleErrors,
  DEFAULT_SEED,
  goToLobby,
  openGameDetails,
  startPrivateGame,
  trackConsoleMessages,
} from "./helpers";

test.describe("UI Smoke Tests - Exit to Home Flow", () => {
  test("Exit to home", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await page.getByRole("button", { name: /Back to game selection/i }).click();

    await expect(page.getByRole("heading", { name: /AnyCard/i })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toHaveCount(0);

    // Verify we're back at home by checking for game cards
    await expect(page.getByTestId("game:briscola")).toBeVisible();

    assertNoConsoleErrors(consoleMessages);
  });
});
