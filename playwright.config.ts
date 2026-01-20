import { defineConfig } from "@playwright/test";

const frontendUrl = "http://localhost:5175";
const backendUrl = "http://localhost:3010";

export default defineConfig({
  testDir: "test/ui-smoke",
  outputDir: "test-artifacts/test-results",
  use: {
    headless: true,
    baseURL: frontendUrl,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    launchOptions: {
      args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"],
    },
    contextOptions: {
      // Mute audio in the browser context
      permissions: [],
    },
  },
  expect: {
    timeout: 10000,
  },
  timeout: 60000,
  globalTimeout: 180000, // 3 minutes for Chromium-only suite
  workers: 4, // Chromium handles parallelization well
  retries: 0, // No retries to save time (tests should be stable)
  fullyParallel: true, // Run tests in parallel across files
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: "test-artifacts/playwright-report",
        open: "never",
      },
    ],
  ],
  webServer: [
    {
      command:
        "PORT=3010 CLIENT_ORIGIN=http://localhost:5175,http://127.0.0.1:5175 BACKEND_LLM_ENABLED=true LLM_POLICY_MODE=firstCandidate LLM_BASE_URL=http://127.0.0.1:1234/v1 npm --prefix backend run dev",
      url: `${backendUrl}/healthz`,
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command:
        "VITE_SERVER_URL=http://localhost:3010 VITE_BROWSER_LLM_ENABLED=true npm --prefix frontend run dev -- --port 5175",
      url: frontendUrl,
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
      },
    },
    // Firefox and WebKit skipped for fast local development
    // Run full cross-browser suite with: npx playwright test --project=chromium --project=firefox --project=webkit
    // {
    //   name: "firefox",
    //   use: {
    //     browserName: "firefox",
    //   },
    //   timeout: 150000,
    // },
    // {
    //   name: "webkit",
    //   use: {
    //     browserName: "webkit",
    //   },
    // },
  ],
});
