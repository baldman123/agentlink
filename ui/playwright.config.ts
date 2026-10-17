// Browser checks for the local app in mock mode (?mock=1: no daemon or hub needed).
//   npx playwright test -c ui/playwright.config.ts      (from the repo root)
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.UI_E2E_PORT ?? 7795);
const CHANNEL = process.env.PW_CHANNEL ?? "chrome";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  expect: { timeout: 6_000 },
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  // the installed Google Chrome, as in cloud/ (PW_CHANNEL="" uses Playwright's own browser)
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], channel: CHANNEL || undefined, viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/?mock=1`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
