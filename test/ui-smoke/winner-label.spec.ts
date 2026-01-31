import { test, expect } from "@playwright/test";
import {
  assertNoConsoleErrors,
  goToLobby,
  seedLocalStorage,
  trackConsoleMessages,
} from "./helpers";

test.describe("UI Smoke Tests - Winner Label", () => {
  test("Shithead shows loser label in meta", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, {
      "ai-runtime-preference": "backend",
    });

    await goToLobby(page);
    await page.getByTestId("game:shithead").click();

    await expect(page.getByRole("button", { name: /Advanced/i })).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole("button", { name: /Advanced/i }).click();

    const seedInput = page.getByPlaceholder(
      "e.g. ABCDEF (Leave blank for random)"
    );
    await expect(seedInput).toBeVisible({ timeout: 5000 });
    await seedInput.fill("shithead-winner-label");

    const privateRoomButton = page.getByRole("button", {
      name: /Private Room/i,
    });
    await expect(privateRoomButton).toBeVisible({ timeout: 5000 });
    await privateRoomButton.click();

    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible({
      timeout: 15000,
    });

    await page.getByTestId("seat-join:P1").click();
    await page.getByTestId("seat-ai-toggle:P2").click();
    await page.getByTestId("seat-ai-toggle:P3").click();
    await page.getByTestId("start-game").click();

    await expect(page.locator(".game-layout").first()).toBeVisible({
      timeout: 15000,
    });

    await expect(page.getByTestId("meta:winner-label")).toHaveText("Loser");

    assertNoConsoleErrors(consoleMessages, [
      /Failed to load resource: the server responded with a status of 404/i,
    ]);
  });
});
