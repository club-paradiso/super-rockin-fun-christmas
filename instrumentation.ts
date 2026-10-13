/**
 * Runs once when the server starts. Validates configuration up front so a broken deployment
 * (e.g. a localhost PUBLIC_BASE_URL in production) is visible in the logs at boot, not only when
 * the first guest is already waiting. Requests that need the config also fail with a 503 and the
 * kiosk shows a staff error screen.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ConfigError, parseServerConfig } = await import("./lib/server/env");
  try {
    const c = parseServerConfig(process.env);
    console.log(
      JSON.stringify({
        level: "info",
        event: "config_ok",
        role: c.role,
        strict: c.strict,
        store: c.store,
        kioskAuth: c.kioskAuth.mode,
        publicBaseUrl: c.publicBaseUrl?.origin ?? null,
        cloud: c.cloudSync?.baseUrl.origin ?? null,
      }),
    );
    if (c.role === "hub" && c.cloudSync) {
      // Copies queued while offline go out in the background (lib/cloud).
      const { startCloudSyncWorker } = await import("./lib/cloud/server");
      startCloudSyncWorker();
    }
    if (c.role === "hub") {
      // No Vercel Cron on the hub: it deletes expired photos itself (D47).
      const { startHubRetention } = await import("./lib/ops/hub-retention-server");
      startHubRetention();
    }
    if (c.role === "hub") {
      // A fresh hub prints its one-time first-staff code in this console window.
      const { ensureSetupCode } = await import("./lib/staff-auth/setup");
      await ensureSetupCode().catch((e) =>
        console.error(
          JSON.stringify({ level: "error", event: "hub_setup_check_failed", message: String(e) }),
        ),
      );
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(
        JSON.stringify({ level: "error", event: "config_invalid", problems: err.problems }),
      );
    } else {
      throw err;
    }
  }
}
