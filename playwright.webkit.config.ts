import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

/**
 * A separate modern-WebKit smoke test of the iPadOS 15 compatibility profile.
 * WebKit from Playwright is NOT Safari 15, so device acceptance remains separate.
 */
export default defineConfig({
  ...base,
  testMatch: /legacy-ipad\.spec\.ts/,
  projects: [
    {
      name: "kiosk-webkit",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 768, height: 1024 },
      },
    },
  ],
});
