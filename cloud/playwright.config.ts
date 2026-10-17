// Browser tests for the website pages against a mocked API and a fake Realtime (e2e/mock.ts).
// They run the production build: `npx next build && npx playwright test` from cloud/.
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3137);
const CHANNEL = process.env.PW_CHANNEL ?? "chrome";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  expect: { timeout: 6_000 },
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  // The installed Google Chrome, so no browser download is needed (PW_CHANNEL="" uses Playwright's own).
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: CHANNEL, viewport: { width: 1440, height: 900 } }, grepInvert: /@phone/ },
    { name: "phone", use: { ...devices["Pixel 7"], channel: CHANNEL }, grep: /@phone/ },
  ],
  webServer: {
    // E2E_DEV=1 runs against `next dev` instead (quicker while editing; the build is what counts)
    command: `npx next ${process.env.E2E_DEV ? "dev" : "start"} --hostname 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
