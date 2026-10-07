import { defineConfig, devices } from "@playwright/test";
import { E2E_ENV, PORT } from "./e2e/env";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  // One server-side store shared by all specs; keep row-count assertions deterministic.
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "kiosk-landscape",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: `rm -rf .data-e2e && npm run build && npx next start -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/kiosk/enroll`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: E2E_ENV,
  },
});
