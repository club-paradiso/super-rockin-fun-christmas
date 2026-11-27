import { defineConfig, devices } from "@playwright/test";
import { E2E_ENV, PORT } from "./e2e/env";

/**
 * Booth smoothness measurement (e2e/kiosk-smoothness.spec.ts), not part of `npm run test:e2e`.
 * Needs a production build made with the E2E environment (`npm run test:e2e` leaves one), then:
 *
 *   MEASURE_SMOOTH=1 npx playwright test -c playwright.smooth.config.ts
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /kiosk-smoothness\.spec\.ts$/,
  timeout: 0,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
    ...(process.env.E2E_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH } }
      : {}),
  },
  webServer: {
    command: `rm -rf .data-e2e && npx next start -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/kiosk/enroll`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: E2E_ENV,
  },
});
