import "server-only";
import { getCloudSync } from "@/lib/cloud/server";
import { getServerConfig } from "@/lib/server/env";
import { logEvent } from "@/lib/server/log";
import { getBackend, getPhotoService } from "@/lib/storage/server";
import { HUB_RETENTION_INTERVAL_MS, runHubRetention } from "./hub-retention";

/** One run now, recorded for the staff overview ("마지막 자동 정리"). */
export async function hubRetentionOnce() {
  const policy = getServerConfig().hubRetention;
  if (!policy) return null;
  const run = await runHubRetention({
    service: getPhotoService(),
    sync: getCloudSync(),
    policy,
    now: new Date(),
  });
  logEvent("retention_cleanup", { ...run }, run.failed ? "warn" : "info");
  await getBackend()
    .retentionRuns.record(run)
    .catch((err: Error) =>
      logEvent("retention_run_record_failed", { message: err.message }, "warn"),
    );
  return run;
}

/** Hub only (instrumentation.ts): a run shortly after start, then every 10 minutes. */
export function startHubRetention() {
  const g = globalThis as { __ftlRetention?: ReturnType<typeof setInterval> };
  if (g.__ftlRetention || !getServerConfig().hubRetention) return;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    hubRetentionOnce()
      .catch((e) => logEvent("retention_failed", { message: String(e) }, "error"))
      .finally(() => (running = false));
  };
  setTimeout(tick, 30_000).unref?.();
  g.__ftlRetention = setInterval(tick, HUB_RETENTION_INTERVAL_MS);
  g.__ftlRetention.unref?.();
}
