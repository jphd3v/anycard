import { test, expect } from "@playwright/test";
import {
  assertNoConsoleErrors,
  DEFAULT_SEED,
  goToLobby,
  openGameDetails,
  rejoinAsPlayer,
  startPrivateGame,
  trackConsoleMessages,
} from "./helpers";

test.describe("UI Smoke Tests - Seed Reset", () => {
  test("Restart hand keeps the same seed", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

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

    await page.locator(".game-layout").first().waitFor();
    await page.getByRole("button", { name: /Menu/i }).click();

    const seedButton = page.getByTitle("Copy Seed");
    await expect(seedButton).toBeVisible();
    const seedBefore = (await seedButton.textContent())?.trim() ?? "";
    expect(seedBefore).not.toEqual("");

    // Click the Restart Hand button
    const restartHandButton = page.getByRole("button", {
      name: "Restart Hand",
      exact: true,
    });
    await expect(restartHandButton).toBeVisible();
    // Use dispatchEvent to bypass potential View Transition overlays
    await restartHandButton.dispatchEvent("click");

    const dialog = page.getByRole("dialog", { name: /Restart this hand\?/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /Restart Hand/i }).click();
    await expect(dialog).toHaveCount(0);

    if (!(await seedButton.isVisible())) {
      await page.getByRole("button", { name: /Menu/i }).click();
    }

    await expect(seedButton).toBeVisible();
    const seedAfter = (await seedButton.textContent())?.trim() ?? "";
    expect(seedAfter).toBe(seedBefore);

    assertNoConsoleErrors(consoleMessages);
  });
});
