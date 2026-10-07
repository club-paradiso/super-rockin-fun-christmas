/**
 * Server environment for the E2E run: a production build with kiosk auth ON, using test-only
 * secrets. Storage is the local backend by default; set E2E_STORE=supabase (plus
 * SUPABASE_TEST_URL / SUPABASE_TEST_SERVICE_ROLE_KEY, e.g. from `npx supabase status`) to run the
 * same suite against a real Supabase stack.
 */
export const PORT = Number(process.env.E2E_PORT ?? 3100);
export const ENROLL_SECRET = "e2e-enroll-secret-not-for-production";
export const USE_SUPABASE = process.env.E2E_STORE === "supabase";

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
      }
    : { PHOTO_STORE: "local", FTL_DATA_DIR: ".data-e2e" }),
};
