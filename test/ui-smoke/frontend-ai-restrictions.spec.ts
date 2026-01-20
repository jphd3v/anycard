import { test, expect, Page } from "@playwright/test";
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

const FRONTEND_AI_STORAGE = {
  "ai-runtime-preference": "frontend",
  "toast-autoclose-enabled": false,
  "local-ai-config": {
    enabled: true,
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "",
    model: "gpt-4o-mini",
  },
};

async function exitGameFromMenu(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Menu/i }).click();
  await page.waitForTimeout(500);
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
  await Promise.race([
    page.getByRole("heading", { name: /Room Lobby/i }).waitFor(),
    page.getByRole("heading", { name: /AnyCard/i }).waitFor(),
  ]);
}

async function exitGameFromAnyView(page: Page): Promise<void> {
  const menuVisible = await page
    .getByRole("button", { name: /Menu/i })
    .isVisible()
    .catch(() => false);
  if (menuVisible) {
    await exitGameFromMenu(page);
    return;
  }

  await page.getByRole("button", { name: /Back to game selection/i }).click();
  await expect(page.getByRole("heading", { name: /AnyCard/i })).toBeVisible();
}

test.describe("UI Smoke Tests - Frontend AI Behavior", () => {
  test("Frontend AI allows switching seats after sponsorship", async ({
    page,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, FRONTEND_AI_STORAGE);
    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await expect(page.getByTestId("seat-card:P1")).toBeVisible();
    await page.getByTestId("seat-join:P2").click();
    await expect(page.getByTestId("seat-state:P2")).toContainText(/Your Seat/i);

    const seatToggle = page.getByTestId("seat-ai-toggle:P2");
    await expect(seatToggle).toBeEnabled();
    await seatToggle.click();
    await expect(page.getByTestId("seat-join:P2")).toHaveCount(0);
    await page.getByTestId("seat-join:P1").click();
    await expect(page.getByTestId("seat-join:P1")).toHaveCount(0);
    await expect(page.getByTestId("seat-join:P2")).toHaveCount(0);

    assertNoConsoleErrors(consoleMessages);
  });

  test("Frontend AI clears when sponsor disconnects", async ({
    page,
    browser,
  }) => {
    const observerConsoleMessages = trackConsoleMessages(page);

    const sponsorContext = await browser.newContext();
    const sponsorPage = await sponsorContext.newPage();
    const sponsorConsoleMessages = trackConsoleMessages(sponsorPage);

    await seedLocalStorage(sponsorPage, FRONTEND_AI_STORAGE);
    await goToLobby(sponsorPage);
    await openGameDetails(sponsorPage);
    await startPrivateGame(sponsorPage, DEFAULT_SEED);

    await sponsorPage.getByTestId("seat-ai-toggle:P2").click();
    await expect(sponsorPage.getByTestId("seat-join:P2")).toHaveCount(0);

    const roomId = await readRoomIdFromLobby(sponsorPage);

    await page.goto(`/${DEFAULT_RULES_ID}/${roomId}`);
    await page
      .getByRole("heading", { name: /Room Lobby/i })
      .waitFor({ timeout: 15000 });

    const observerSeatCard = page.getByTestId("seat-card:P2");
    await expect(observerSeatCard).toBeVisible();
    await expect(page.getByTestId("seat-join:P2")).toHaveCount(0);
    await expect(observerSeatCard.getByText(/AI \(browser\)/i)).toBeVisible();

    await sponsorContext.close();

    await expect(page.getByTestId("seat-join:P2")).toBeVisible({
      timeout: 15000,
    });
    await expect(observerSeatCard.getByText(/AI \(browser\)/i)).toHaveCount(0);

    assertNoConsoleErrors(observerConsoleMessages);
    assertNoConsoleErrors(sponsorConsoleMessages);
  });

  test("Frontend AI can be toggled off from the lobby", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, FRONTEND_AI_STORAGE);
    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await expect(page.getByTestId("seat-card:P1")).toBeVisible();
    const seatToggle = page.getByTestId("seat-ai-toggle:P2");
    await seatToggle.click();
    await expect(page.getByTestId("seat-join:P2")).toHaveCount(0);

    await seatToggle.click();
    await expect(page.getByTestId("seat-join:P2")).toBeVisible();

    assertNoConsoleErrors(consoleMessages);
  });

  test("Frontend AI clears when sponsor leaves mid-game", async ({
    page,
    browser,
  }) => {
    const playerConsoleMessages = trackConsoleMessages(page);

    const sponsorContext = await browser.newContext();
    const sponsorPage = await sponsorContext.newPage();
    const sponsorConsoleMessages = trackConsoleMessages(sponsorPage);

    await seedLocalStorage(sponsorPage, FRONTEND_AI_STORAGE);
    await goToLobby(sponsorPage);
    await openGameDetails(sponsorPage);
    await startPrivateGame(sponsorPage, DEFAULT_SEED);

    await sponsorPage.getByTestId("seat-ai-toggle:P2").click();
    await expect(sponsorPage.getByTestId("seat-join:P2")).toHaveCount(0);

    await sponsorPage
      .getByRole("button", { name: /Watch as Spectator/i })
      .click();
    await expect(
      sponsorPage.getByText(/You are watching as a spectator/i)
    ).toBeVisible();

    const roomId = await readRoomIdFromLobby(sponsorPage);

    await page.goto(`/${DEFAULT_RULES_ID}/${roomId}`);
    await page
      .getByRole("heading", { name: /Room Lobby/i })
      .waitFor({ timeout: 15000 });
    await page.getByTestId("seat-join:P1").click();
    await expect(page.getByTestId("start-game")).toBeVisible();

    await page.getByTestId("start-game").click();
    await expect(page.getByTestId("start-game")).toHaveCount(0);
    await page.locator(".game-layout").first().waitFor({ timeout: 15000 });

    const p2HandPile = page.getByTestId("pile:P2-hand");
    const p2HandPileContainer = p2HandPile.locator("..");
    await expect(p2HandPile).toBeVisible();
    await expect(p2HandPileContainer.getByText(/^AI$/)).toBeVisible();

    await exitGameFromAnyView(sponsorPage);

    await expect(p2HandPileContainer.getByText(/^AI$/)).toHaveCount(0);

    await sponsorContext.close();
    assertNoConsoleErrors(playerConsoleMessages);
    assertNoConsoleErrors(sponsorConsoleMessages);
  });

  test("Frontend AI persists after refresh", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, FRONTEND_AI_STORAGE);
    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    const seatToggle = page.getByTestId("seat-ai-toggle:P2");
    await seatToggle.click();
    await expect(page.getByTestId("seat-join:P2")).toHaveCount(0);

    await page.reload();

    await expect(
      page.getByRole("heading", { name: /Room Lobby/i })
    ).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("seat-card:P2")).toBeVisible();
    await expect(page.getByTestId("seat-join:P2")).toHaveCount(0);

    assertNoConsoleErrors(consoleMessages);
  });

  test("Frontend AI clears when sponsor leaves", async ({ page, browser }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, FRONTEND_AI_STORAGE);
    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await page.getByTestId("seat-ai-toggle:P2").click();
    await expect(page.getByTestId("seat-join:P2")).toHaveCount(0);

    const roomId = await readRoomIdFromLobby(page);
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    const otherConsoleMessages = trackConsoleMessages(otherPage);

    await otherPage.goto(`/${DEFAULT_RULES_ID}/${roomId}`);
    await otherPage
      .getByRole("heading", { name: /Room Lobby/i })
      .waitFor({ timeout: 15000 });

    const otherSeatCard = otherPage.getByTestId("seat-card:P2");
    await expect(otherSeatCard).toBeVisible();
    await expect(otherPage.getByTestId("seat-join:P2")).toHaveCount(0);
    await expect(otherSeatCard.getByText(/AI \(browser\)/i)).toBeVisible();

    await page.getByRole("button", { name: /Back to game selection/i }).click();
    await expect(page.getByRole("heading", { name: /AnyCard/i })).toBeVisible();

    await expect(otherPage.getByTestId("seat-join:P2")).toBeVisible({
      timeout: 15000,
    });
    await expect(otherSeatCard.getByText(/AI \(browser\)/i)).toHaveCount(0);

    await otherContext.close();
    assertNoConsoleErrors(consoleMessages);
    assertNoConsoleErrors(otherConsoleMessages);
  });

  test("Spectator can sponsor frontend AI while humans are present", async ({
    page,
    browser,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, FRONTEND_AI_STORAGE);
    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await expect(page.getByTestId("seat-card:P1")).toBeVisible();
    await page.getByRole("button", { name: /Watch as Spectator/i }).click();
    await expect(
      page.getByText(/You are watching as a spectator/i)
    ).toBeVisible();

    const roomId = await readRoomIdFromLobby(page);
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

    const seatToggle = page.getByTestId("seat-ai-toggle:P2");
    await expect(seatToggle).toBeEnabled();
    await seatToggle.click();
    await expect(page.getByTestId("seat-join:P2")).toHaveCount(0);

    await otherContext.close();
    assertNoConsoleErrors(consoleMessages);
  });

  test("Player can watch sponsored frontend AI as spectator", async ({
    page,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, FRONTEND_AI_STORAGE);
    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await page.getByTestId("seat-join:P2").click();
    await expect(page.getByTestId("seat-state:P2")).toContainText(/Your Seat/i);

    const seatToggle = page.getByTestId("seat-ai-toggle:P2");
    await seatToggle.click();
    await expect(page.getByTestId("seat-join:P2")).toHaveCount(0);

    await page.getByRole("button", { name: /Watch as Spectator/i }).click();
    await expect(
      page.getByText(/You are watching as a spectator/i)
    ).toBeVisible();
    await expect(page.getByTestId("seat-join:P2")).toHaveCount(0);

    assertNoConsoleErrors(consoleMessages);
  });

  test("Frontend AI shows warning banner in lobby", async ({ page }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, FRONTEND_AI_STORAGE);
    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await expect(page.getByTestId("seat-card:P1")).toBeVisible();
    await page.getByTestId("seat-join:P2").click();
    const seatToggle = page.getByTestId("seat-ai-toggle:P2");
    await seatToggle.click();
    await expect(
      page.getByText(/Warning: Frontend AI runs in a browser/i)
    ).toBeVisible();

    assertNoConsoleErrors(consoleMessages);
  });

  test("Frontend AI sponsorship persists when another player joins", async ({
    page,
    browser,
  }) => {
    const consoleMessages = trackConsoleMessages(page);

    await seedLocalStorage(page, FRONTEND_AI_STORAGE);
    await goToLobby(page);
    await openGameDetails(page);
    await startPrivateGame(page, DEFAULT_SEED);

    await expect(page.getByTestId("seat-card:P1")).toBeVisible();
    await page.getByTestId("seat-join:P2").click();
    await page.getByTestId("seat-ai-toggle:P2").click();
    await expect(page.getByTestId("seat-join:P2")).toHaveCount(0);

    await page.getByRole("button", { name: /Watch as Spectator/i }).click();
    await expect(
      page.getByText(/You are watching as a spectator/i)
    ).toBeVisible();

    const roomId = await readRoomIdFromLobby(page);
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await otherPage.goto(`/${DEFAULT_RULES_ID}/${roomId}`);
    await otherPage
      .getByRole("heading", { name: /Room Lobby/i })
      .waitFor({ timeout: 15000 });
    await expect(otherPage.getByTestId("seat-card:P1")).toBeVisible();
    await otherPage.getByTestId("seat-join:P1").click();
    await expect(otherPage.getByTestId("seat-join:P1")).toHaveCount(0);

    await expect(page.getByTestId("seat-join:P2")).toHaveCount(0);

    await otherContext.close();
    assertNoConsoleErrors(consoleMessages);
  });
});
