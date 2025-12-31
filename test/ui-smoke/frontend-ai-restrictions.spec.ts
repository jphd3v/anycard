import { test, expect } from "@playwright/test";
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
