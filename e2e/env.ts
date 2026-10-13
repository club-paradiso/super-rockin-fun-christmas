/**
 * Server environment for the E2E run: a production build with kiosk auth ON, using test-only
 * secrets. By default it runs as the on-site hub (FTL_ROLE=hub, local files, PIN staff login).
 * Set E2E_STORE=supabase (plus SUPABASE_TEST_URL / SUPABASE_TEST_SERVICE_ROLE_KEY, e.g. from
 * `npx supabase status`) to run the same suite as the cloud against a real Supabase stack.
 */
export const PORT = Number(process.env.E2E_PORT ?? 3100);
export const ENROLL_SECRET = "e2e-enroll-secret-not-for-production";
export const USE_SUPABASE = process.env.E2E_STORE === "supabase";
/** First-staff setup code for the hub run (normally printed in the hub console). */
export const HUB_SETUP_CODE = "E2E2-HUB3";
export const MAILPIT_URL = process.env.SUPABASE_TEST_MAILPIT_URL ?? "http://127.0.0.1:54324";

export const E2E_ENV: Record<string, string> = {
  NEXT_TELEMETRY_DISABLED: "1",
  // Allows the 127.0.0.1 origin in a production build. Ignored on Vercel.
  FTL_ALLOW_LOCAL_ORIGIN: "1",
  PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}`,
  KIOSK_SESSION_SECRET: "e2e-session-secret-0123456789-abcdefghijklmnop",
  KIOSK_ENROLL_SECRET: ENROLL_SECRET,
  CRON_SECRET: "e2e-cron-secret-0123456789-abcdefghijklmnopqrstuv",
  ...(USE_SUPABASE
    ? {
        PHOTO_STORE: "supabase",
        SUPABASE_URL: process.env.SUPABASE_TEST_URL ?? "",
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? "",
        // Server-only: used by the Next.js server for staff login (Supabase Auth).
        SUPABASE_ANON_KEY: process.env.SUPABASE_TEST_ANON_KEY ?? "",
      }
    : {
        FTL_ROLE: "hub",
        PHOTO_STORE: "local",
        FTL_DATA_DIR: ".data-e2e",
        FTL_HUB_SETUP_CODE: HUB_SETUP_CODE,
      }),
};

/**
 * Hub + cloud pair for e2e/cloud.spec.ts (hub runs only): a second hub with CLOUD_BASE_URL, and a
 * cloud-role server with its own store. The hub reaches the cloud through a proxy the spec starts
 * and stops, so "the internet goes down" is a real refused connection.
 */
export const CLOUD_PORT = PORT + 1;
export const HUB_CLOUD_PORT = PORT + 2;
export const CLOUD_PROXY_PORT = PORT + 3;
const HUB_SYNC_SECRET = "e2e-hub-sync-secret-0123456789-abcdefghijklmnop";

export const CLOUD_ENV: Record<string, string> = {
  ...E2E_ENV,
  FTL_ROLE: "cloud",
  PHOTO_STORE: "local",
  FTL_DATA_DIR: ".data-e2e-cloud",
  PUBLIC_BASE_URL: `http://127.0.0.1:${CLOUD_PORT}`,
  HUB_SYNC_SECRET,
};
delete CLOUD_ENV.FTL_HUB_SETUP_CODE;

export const HUB_CLOUD_ENV: Record<string, string> = {
  ...E2E_ENV,
  FTL_DATA_DIR: ".data-e2e-hub-cloud",
  PUBLIC_BASE_URL: `http://127.0.0.1:${HUB_CLOUD_PORT}`,
  CLOUD_BASE_URL: `http://127.0.0.1:${CLOUD_PROXY_PORT}`,
  HUB_SYNC_SECRET,
  CLOUD_SYNC_TIMEOUT_MS: "3000",
};
