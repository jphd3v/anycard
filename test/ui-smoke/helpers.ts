import { expect, Page } from "@playwright/test";

export const DEFAULT_RULES_ID = "briscola";
export const DEFAULT_SEED = "ui-smoke-12345";

export type ConsoleRecord = {
  type: string;
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

export function assertNoConsoleErrors(
  records: ConsoleRecord[],
  ignorePatterns: RegExp[] = []
): void {
  // Default patterns to ignore (browser-specific quirks that don't indicate problems)
  const defaultIgnorePatterns = [
    /XML Parsing Error/i, // Firefox-specific: logs when parsing non-XML responses
    /due to access control checks/i, // WebKit-specific: CORS preflight logging
    /WebKit encountered an internal error/i, // WebKit-specific: internal errors during network simulation
  ];

  const allIgnorePatterns = [...defaultIgnorePatterns, ...ignorePatterns];

  const errors = records.filter((record) => {
    if (record.type !== "error") return false;
    // Check if error matches any ignore pattern
    return !allIgnorePatterns.some((pattern) => pattern.test(record.message));
  });
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
  // Wait for the modal to open by checking for the "Advanced" button or "Start Private Room" button
  await page.waitForTimeout(500);
  await expect(page.getByRole("button", { name: /Advanced/i })).toBeVisible({
    timeout: 15000,
  });
}

export async function startPrivateGame(
  page: Page,
  seed: string
): Promise<void> {
  await page.getByRole("button", { name: /Advanced/i }).click();

  const seedInput = page.getByPlaceholder(
    "e.g. ABCDEF (Leave blank for random)"
  );
  await expect(seedInput).toBeVisible({ timeout: 5000 });
  await seedInput.fill(seed);

  const privateRoomButton = page.getByRole("button", { name: /Private Room/i });
  await expect(privateRoomButton).toBeVisible({ timeout: 5000 });
  await privateRoomButton.click();

  await expect(page.getByRole("heading", { name: /Room Lobby/i })).toBeVisible({
    timeout: 15000, // Reasonable timeout for Chromium (increased from original 10s for stability)
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

export async function simulateOffline(page: Page, context: any): Promise<void> {
  await context.setOffline(true);
  // Manually dispatch offline event since Playwright doesn't trigger it
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
  });
}

export async function simulateOnline(page: Page, context: any): Promise<void> {
  await context.setOffline(false);
  // Manually dispatch online event since Playwright doesn't trigger it
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
  });
}
