import "server-only";
import { getServerConfig } from "@/lib/server/env";
import { logEvent } from "@/lib/server/log";
import { getBackend } from "@/lib/storage/server";
import { HttpCloudClient } from "./client";
import { CloudSync } from "./sync";

/**
 * One CloudSync per process. Next.js bundles each route separately, so a module-level singleton
 * would be duplicated per route and the per-photo lock would not hold; keep it on globalThis.
 * Null unless this is a hub with CLOUD_BASE_URL + HUB_SYNC_SECRET.
 */
export function getCloudSync(): CloudSync | null {
  const cfg = getServerConfig().cloudSync;
  if (!cfg) return null;
  const g = globalThis as { __ftlCloudSync?: CloudSync };
  g.__ftlCloudSync ??= new CloudSync(
    getBackend(),
    new HttpCloudClient(cfg.baseUrl, cfg.secret, cfg.timeoutMs),
  );
  return g.__ftlCloudSync;
}

/** Background retries (instrumentation.ts). Uploads and deletes queued while offline go out. */
export function startCloudSyncWorker(intervalMs = 15_000) {
  const g = globalThis as { __ftlCloudWorker?: ReturnType<typeof setInterval> };
  if (g.__ftlCloudWorker || !getCloudSync()) return;
  let running = false;
  g.__ftlCloudWorker = setInterval(() => {
    const sync = getCloudSync();
    if (!sync || running) return;
    running = true;
    sync
      .processDue()
      .catch((e) => logEvent("cloud_sync_failed", { message: String(e) }, "warn"))
      .finally(() => (running = false));
  }, intervalMs);
  g.__ftlCloudWorker.unref?.();
}

/** Tests only. */
export function resetCloudSyncForTests() {
  const g = globalThis as {
    __ftlCloudSync?: CloudSync;
    __ftlCloudWorker?: ReturnType<typeof setInterval>;
  };
  if (g.__ftlCloudWorker) clearInterval(g.__ftlCloudWorker);
  delete g.__ftlCloudWorker;
  delete g.__ftlCloudSync;
}
