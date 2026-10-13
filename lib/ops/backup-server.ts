import "server-only";
import path from "node:path";
import { getServerConfig } from "@/lib/server/env";
import { logEvent } from "@/lib/server/log";
import { flushLocalBackends, snapshotLocalBackend } from "@/lib/storage/local-backend";
import { freeBytes, readBackupMarker, runBackup, type BackupResult } from "./backup";

/** Process-wide (routes are bundled separately): the last outcome and the run in progress. */
interface BackupState {
  last: BackupResult | null;
  error: { at: string; message: string } | null;
  running: Promise<BackupResult> | null;
  timer?: ReturnType<typeof setInterval>;
}
const state = () =>
  ((globalThis as { __ftlBackup?: BackupState }).__ftlBackup ??= {
    last: null,
    error: null,
    running: null,
  });

function dirs() {
  const c = getServerConfig();
  if (!c.hubOps) return null;
  const dataDir = path.resolve(/* turbopackIgnore: true */ process.cwd(), c.localDataDir);
  const backupDir = c.hubOps.backupDir
    ? path.resolve(/* turbopackIgnore: true */ process.cwd(), c.hubOps.backupDir)
    : null;
  return { dataDir, backupDir, ops: c.hubOps };
}

/** One backup now; a run already in progress is joined rather than started twice. */
export function backupNow(): Promise<BackupResult> {
  const s = state();
  const d = dirs();
  if (!d?.backupDir) return Promise.reject(new Error("HUB_BACKUP_DIR is not set"));
  const { dataDir, backupDir } = d;
  s.running ??= (async () => {
    try {
      await flushLocalBackends();
      const result = await runBackup({
        dataDir,
        backupDir,
        snapshot: () => snapshotLocalBackend(dataDir),
      });
      s.last = result;
      s.error = null;
      logEvent("backup_ok", { ...result });
      return result;
    } catch (err) {
      const message = (err as Error).message;
      s.error = { at: new Date().toISOString(), message };
      logEvent("backup_failed", { message }, "error");
      throw err;
    } finally {
      s.running = null;
    }
  })();
  return s.running;
}

/** Hub only (instrumentation.ts): a backup a minute after start, then every HUB_BACKUP_MINUTES. */
export function startHubBackup() {
  const s = state();
  const d = dirs();
  if (s.timer || !d?.backupDir) return;
  const tick = () => void backupNow().catch(() => undefined);
  setTimeout(tick, 60_000).unref?.();
  s.timer = setInterval(tick, d.ops.backupMinutes * 60_000);
  s.timer.unref?.();
}

export interface OpsStatus {
  backup: {
    configured: boolean;
    everyMinutes: number;
    /** Last finished backup (this process, or the marker on the stick after a restart). */
    lastAt: string | null;
    files: number | null;
    error: { at: string; message: string } | null;
    /** No finished backup within three intervals (or none at all). */
    stale: boolean;
  };
  disk: {
    dataFree: number | null;
    backupFree: number | null;
    warnBelow: number;
  };
}

/** For the staff overview. Null on the cloud. */
export async function opsStatus(): Promise<OpsStatus | null> {
  const d = dirs();
  if (!d) return null;
  const s = state();
  const marker = !s.last && d.backupDir ? await readBackupMarker(d.backupDir) : null;
  const last = s.last ?? marker;
  const staleAfter = d.ops.backupMinutes * 3 * 60_000;
  return {
    backup: {
      configured: !!d.backupDir,
      everyMinutes: d.ops.backupMinutes,
      lastAt: last?.at ?? null,
      files: last?.files ?? null,
      error: s.error,
      stale: !last || Date.now() - new Date(last.at).getTime() > staleAfter,
    },
    disk: {
      dataFree: await freeBytes(d.dataDir),
      backupFree: d.backupDir ? await freeBytes(d.backupDir) : null,
      warnBelow: d.ops.diskWarnBytes,
    },
  };
}
