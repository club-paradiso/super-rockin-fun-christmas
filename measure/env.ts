/** Hub environment for the Phase 4 measurement run (production build, local files). */
export const MEASURE_PORT = Number(process.env.MEASURE_PORT ?? 3300);
export const MEASURE_SETUP_CODE = "MEAS-HUB4";
export const MEASURE_PIN = "730514";
export const MEASURE_OUT = process.env.MEASURE_OUT ?? "docs/measurements/raw";

export const MEASURE_ENV: Record<string, string> = {
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_ENV: "production",
  FTL_ALLOW_LOCAL_ORIGIN: "1",
  PUBLIC_BASE_URL: `http://127.0.0.1:${MEASURE_PORT}`,
  KIOSK_SESSION_SECRET: "measure-session-secret-0123456789-abcdefghijklmnop",
  KIOSK_ENROLL_SECRET: "measure-enroll-secret-not-for-production",
  CRON_SECRET: "measure-cron-secret-0123456789-abcdefghijklmnopqrstuv",
  FTL_ROLE: "hub",
  PHOTO_STORE: "local",
  FTL_DATA_DIR: ".data-measure",
  FTL_HUB_SETUP_CODE: MEASURE_SETUP_CODE,
  HUB_BACKUP_DIR: ".data-measure-usb",
  // Only the explicit backup calls in the run, not the 10-minute timer in the middle of a timing.
  HUB_BACKUP_MINUTES: "1440",
  MEASURE_OUT,
  MEASURE_PHOTOS: process.env.MEASURE_PHOTOS ?? "3000",
};
