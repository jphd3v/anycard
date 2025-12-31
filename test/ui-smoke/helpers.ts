import { expect, Page } from "@playwright/test";

export const DEFAULT_RULES_ID = "briscola";
export const DEFAULT_SEED = "ui-smoke-12345";

export type ConsoleRecord = {
  type: "error" | "warning";
  message: string;
};

export function trackConsoleMessages(page: Page): ConsoleRecord[] {
  const records: ConsoleRecord[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      records.push({
        type: msg.type(),
        message: msg.text(),
      });
    }
  });

  page.on("pageerror", (error) => {
    records.push({
      type: "error",
      message: error.message,
    });
  });

  return records;
}

export function assertNoConsoleErrors(records: ConsoleRecord[]): void {
  const errors = records.filter((record) => record.type === "error");
  if (errors.length === 0) return;

  const details = errors.map((error) => `- ${error.message}`).join("\n");
  throw new Error(`Console errors detected:\n${details}`);
}

export async function goToLobby(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /AnyCard/i })).toBeVisible();
  await page
    .getByRole("heading", { name: /Loading games/i })
    .waitFor({ state: "detached", timeout: 30000 })
    .catch(() => {});
  await expect(page.getByTestId(`game:${DEFAULT_RULES_ID}`)).toBeVisible({
    timeout: 30000,
  });
}

export async function openGameDetails(page: Page): Promise<void> {
  await page.getByTestId(`game:${DEFAULT_RULES_ID}`).click();
  await expect(
    page.getByRole("heading", { name: /Start New Game/i })
  ).toBeVisible();
}

export async function startPrivateGame(
  page: Page,
  seed: string
): Promise<void> {
  await page.getByRole("button", { name: /Advanced/i }).click();
  await page
    .getByPlaceholder("e.g. ABCDEF (Leave blank for random)")
    .fill(seed);
  await page.getByRole("button", { name: /Private Room/i }).click();
  await expect(page.getByRole("heading", { name: /Room Lobby/i })).toBeVisible({
    timeout: 15000,
  });
}

export async function readRoomIdFromLobby(page: Page): Promise<string> {
  const idText = await page.locator("text=/^ID: /").first().textContent();
  const gameId = idText?.replace(/^ID:\s*/, "").trim();
  if (!gameId) {
    throw new Error("Failed to read game ID from room lobby.");
  }
  return gameId;
}

export async function rejoinAsPlayer(page: Page): Promise<void> {
  const gameId = await readRoomIdFromLobby(page);

  await page.evaluate(
    ({ gameId, rulesId }) => {
      const recentGames = [
        {
          gameId,
          rulesId,
          roomType: "private",
          lastRole: "player",
          lastPlayerId: "P1",
          lastJoinedAt: Date.now(),
        },
      ];
      window.localStorage.setItem("recent-games", JSON.stringify(recentGames));
    },
    { gameId, rulesId: DEFAULT_RULES_ID }
  );

  await page.reload();
  await expect(page.getByText(/You have taken a seat/i)).toBeVisible({
    timeout: 15000,
  });
}

export async function waitForGameReady(page: Page): Promise<void> {
  await Promise.race([
    page.getByRole("heading", { name: /Room Lobby/i }).waitFor(),
    page.locator(".game-layout").first().waitFor(),
  ]);
}

export async function seedLocalStorage(
  page: Page,
  values: Record<string, unknown>
): Promise<void> {
  await page.addInitScript((entries) => {
    Object.entries(entries).forEach(([key, value]) => {
      window.localStorage.setItem(key, JSON.stringify(value));
    });
  }, values);
}
