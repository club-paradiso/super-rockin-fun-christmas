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
        strict: c.strict,
        store: c.store,
        kioskAuth: c.kioskAuth.mode,
        publicBaseUrl: c.publicBaseUrl?.origin ?? null,
      }),
    );
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
