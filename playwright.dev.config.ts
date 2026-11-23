import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

/**
 * Iteration config: uses a booth server that is already running (start one with the E2E
 * environment of e2e/env.ts), so a compositor or test change needs no rebuild.
 *   PW_ENGINE=webkit picks WebKit.
 */
const webkit = process.env.PW_ENGINE === "webkit";
export default defineConfig({
  ...base,
  webServer: undefined,
  projects: [
    webkit
      ? {
          name: "webkit",
          use: { ...devices["Desktop Safari"], viewport: { width: 768, height: 1024 } },
        }
      : {
          name: "chromium",
          use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } },
        },
  ],
});
