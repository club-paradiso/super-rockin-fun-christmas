import { defineConfig, devices } from "@playwright/test";
import {
  CLOUD_ENV,
  CLOUD_PORT,
  E2E_ENV,
  HUB_CLOUD_ENV,
  HUB_CLOUD_PORT,
  PORT,
  USE_SUPABASE,
} from "./e2e/env";

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
  // Started one after another: the first builds, the others reuse the build with their own env.
  webServer: [
    {
      command: `rm -rf .data-e2e && npm run build && npx next start -p ${PORT} -H 127.0.0.1`,
      url: `http://127.0.0.1:${PORT}/kiosk/enroll`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: E2E_ENV,
    },
    // Hub + cloud pair for e2e/cloud.spec.ts (QR copy, cloud outage). Hub runs only.
    ...(USE_SUPABASE
      ? []
      : [
          {
            command: `rm -rf .data-e2e-cloud && npx next start -p ${CLOUD_PORT} -H 127.0.0.1`,
            url: `http://127.0.0.1:${CLOUD_PORT}/kiosk/enroll`,
            reuseExistingServer: false,
            timeout: 60_000,
            env: CLOUD_ENV,
          },
          {
            command: `rm -rf .data-e2e-hub-cloud && npx next start -p ${HUB_CLOUD_PORT} -H 127.0.0.1`,
            url: `http://127.0.0.1:${HUB_CLOUD_PORT}/kiosk/enroll`,
            reuseExistingServer: false,
            timeout: 60_000,
            env: HUB_CLOUD_ENV,
          },
        ]),
  ],
});
