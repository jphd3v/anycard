import { test, expect } from "@playwright/test";
import {
  assertNoConsoleErrors,
  DEFAULT_SEED,
  goToLobby,
  openGameDetails,
  rejoinAsPlayer,
  seedLocalStorage,
  skipStartGameOverlayIfPresent,
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
    await skipStartGameOverlayIfPresent(page);

    await page.getByRole("button", { name: /Menu/i }).click();
    const quitButton = page.getByRole("button", { name: /Quit Game/i });
    try {
      await quitButton.waitFor({ state: "visible", timeout: 5000 });
    } catch {
      await page.getByRole("button", { name: /Menu/i }).click();
      await quitButton.waitFor({ state: "visible", timeout: 5000 });
    }
    // Programmatically click to bypass view transition stability issues
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const quitButton = buttons.find((b) =>
        b.textContent?.includes("Quit Game")
      );
      if (quitButton) {
        quitButton.click();
        return true;
      }
      return false;
    });
    if (!clicked) {
      throw new Error("Quit Game button not found - cannot click");
    }
    await page
      .getByRole("dialog", { name: /Exit to room lobby/i })
      .waitFor({ state: "visible" });
    await expect(
      page.getByRole("dialog", { name: /Exit to room lobby/i })
    ).toBeVisible();
    await page.getByRole("button", { name: /Exit to Lobby/i }).click();
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible();

    assertNoConsoleErrors(consoleMessages);
  });

  test("Scoreboard state resets when switching to another game", async ({
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

    const seatToggle = page.getByTestId("seat-ai-toggle:P2");
    await expect(seatToggle).toBeEnabled();
    await seatToggle.click();
    await expect(page.getByTestId("start-game")).toBeVisible();
    await page.getByTestId("start-game").click();
    await skipStartGameOverlayIfPresent(page);

    const firstScoreButton = page.locator("#tutorial-scores-btn");
    await expect(firstScoreButton).toBeVisible();
    await firstScoreButton.click();
    await expect(firstScoreButton).toHaveClass(/button-primary/);

    await page.getByRole("button", { name: /Menu/i }).click();
    const quitButton = page.getByRole("button", { name: /Quit Game/i });
    try {
      await quitButton.waitFor({ state: "visible", timeout: 5000 });
    } catch {
      await page.getByRole("button", { name: /Menu/i }).click();
      await quitButton.waitFor({ state: "visible", timeout: 5000 });
    }
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const quitButton = buttons.find((b) =>
        b.textContent?.includes("Quit Game")
      );
      if (quitButton) {
        quitButton.click();
        return true;
      }
      return false;
    });
    if (!clicked) {
      throw new Error("Quit Game button not found - cannot click");
    }
    await page
      .getByRole("dialog", { name: /Exit to room lobby/i })
      .waitFor({ state: "visible" });
    await page.getByRole("button", { name: /Exit to Lobby/i }).click();
    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible();
    await page.getByRole("button", { name: /Back to game selection/i }).click();
    const closeDetailsButton = page.getByLabel("Back");
    if (await closeDetailsButton.isVisible().catch(() => false)) {
      await closeDetailsButton.click();
    }
    await expect(page.getByTestId("game:durak")).toBeVisible();

    await page.getByTestId("game:durak").click();
    await expect(page.getByRole("button", { name: /Advanced/i })).toBeVisible();
    await startPrivateGame(page, `${DEFAULT_SEED}-durak`);
    await rejoinAsPlayer(page, "durak");

    const durakSeatToggle = page.getByTestId("seat-ai-toggle:P2");
    await expect(durakSeatToggle).toBeEnabled();
    await durakSeatToggle.click();
    await expect(page.getByTestId("start-game")).toBeVisible();
    await page.getByTestId("start-game").click();
    await skipStartGameOverlayIfPresent(page);

    const secondScoreButton = page.locator("#tutorial-scores-btn");
    await expect(secondScoreButton).toBeVisible();
    await expect(secondScoreButton).not.toHaveClass(/button-primary/);

    assertNoConsoleErrors(consoleMessages, [
      /Failed to load resource: the server responded with a status of 404 \(Not Found\)/i,
    ]);
  });
});
