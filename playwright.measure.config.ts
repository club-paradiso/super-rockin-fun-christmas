import { defineConfig, devices } from "@playwright/test";
import { MEASURE_ENV, MEASURE_PORT } from "./measure/env";

/**
 * Phase 4 measurements (not part of `npm run test:e2e`): a production hub seeded with thousands
 * of photos, then load timings and a long wall run. Needs a production build (`npm run build`).
 *
 *   npx playwright test -c playwright.measure.config.ts
 *   MEASURE_PHOTOS=3000 SOAK_MINUTES=180 npx playwright test -c playwright.measure.config.ts
 *
 * Results go to MEASURE_OUT (default docs/measurements/raw).
 */
export default defineConfig({
  testDir: "./measure",
  testMatch: /.*\.measure\.ts$/,
  timeout: 0,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${MEASURE_PORT}`, ...devices["Desktop Chrome"] },
  webServer: {
    command:
      `rm -rf ${MEASURE_ENV.FTL_DATA_DIR} ${MEASURE_ENV.HUB_BACKUP_DIR} && mkdir -p ${MEASURE_ENV.HUB_BACKUP_DIR} && ` +
      `JITI_ALIAS='{"@":"${process.cwd()}"}' MEASURE_DATA=${MEASURE_ENV.FTL_DATA_DIR} npx jiti measure/seed.ts && ` +
      `npx next start -p ${MEASURE_PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${MEASURE_PORT}/kiosk/enroll`,
    reuseExistingServer: false,
    timeout: 1_800_000,
    env: MEASURE_ENV,
    stdout: "ignore",
  },
});
