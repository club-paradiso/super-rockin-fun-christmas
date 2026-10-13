import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

/**
 * Hub backup to a USB stick (docs/ARCHITECTURE.md 1.2, RUNBOOK 7). A mirror, not an archive:
 *
 *   <HUB_BACKUP_DIR>/ftl-backup/db.json        consistent snapshot of the hub database
 *   <HUB_BACKUP_DIR>/ftl-backup/objects/...    the same image files as the hub
 *   <HUB_BACKUP_DIR>/ftl-backup/backup.json    when it last finished
 *
 * Files deleted on the hub (staff deletes, retention) are deleted from the backup on the next
 * run, so the backup never keeps a photo longer than the hub does. HUB_BACKUP_DIR itself must
 * already exist: if the stick is not plugged in, the run fails instead of quietly filling the
 * laptop's own disk at the same path.
 */
export const BACKUP_FOLDER = "ftl-backup";

export interface BackupResult {
  at: string;
  copied: number;
  removed: number;
  files: number;
  bytes: number;
}

export interface BackupMarker extends BackupResult {
  version: 1;
}

const README = `FOLLOW THE LIGHTS hub backup.
This folder holds guest photos. Keep the stick with the event lead and delete this folder when
the church's retention period ends (docs/RUNBOOK.md section 8).
Restore: scripts/hub-restore.mjs (desktop icon "백업에서 복구").
`;

async function walk(dir: string, base = dir): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) for (const [k, v] of await walk(full, base)) out.set(k, v);
    else if (e.isFile()) out.set(path.relative(base, full), (await stat(full)).size);
  }
  return out;
}

async function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export async function runBackup(opts: {
  dataDir: string;
  backupDir: string;
  /** db.json as it is right now (snapshotLocalBackend). */
  snapshot: () => Promise<string>;
  now?: () => Date;
}): Promise<BackupResult> {
  const root = await stat(opts.backupDir).catch(() => null);
  if (!root?.isDirectory())
    throw new Error(`backup location not found: ${opts.backupDir} (is the USB stick plugged in?)`);
  const target = path.join(opts.backupDir, BACKUP_FOLDER);
  const targetObjects = path.join(target, "objects");
  await mkdir(targetObjects, { recursive: true });

  // Database first: images added after it are harmless extras, fixed on the next run.
  const db = await opts.snapshot();
  await writeAtomic(path.join(target, "db.json"), db);

  const source = await walk(path.join(opts.dataDir, "objects"));
  const mirrored = await walk(targetObjects);
  let copied = 0;
  let removed = 0;
  let bytes = 0;
  for (const [rel, size] of source) {
    bytes += size;
    if (mirrored.get(rel) === size) continue;
    const dest = path.join(targetObjects, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(opts.dataDir, "objects", rel), dest);
    copied++;
  }
  for (const rel of mirrored.keys()) {
    if (source.has(rel)) continue;
    await rm(path.join(targetObjects, rel), { force: true });
    removed++;
  }

  const result: BackupResult = {
    at: (opts.now?.() ?? new Date()).toISOString(),
    copied,
    removed,
    files: source.size,
    bytes,
  };
  await writeFile(path.join(target, "README.txt"), README);
  await writeAtomic(
    path.join(target, "backup.json"),
    JSON.stringify({ version: 1, ...result } satisfies BackupMarker),
  );
  return result;
}

/** The last finished backup in `backupDir`, or null (none yet, or the stick is not there). */
export async function readBackupMarker(backupDir: string): Promise<BackupMarker | null> {
  try {
    const m = JSON.parse(
      await readFile(path.join(backupDir, BACKUP_FOLDER, "backup.json"), "utf8"),
    ) as BackupMarker;
    return m.version === 1 && typeof m.at === "string" ? m : null;
  } catch {
    return null;
  }
}

/** Free bytes on the disk holding `dir`, or null when it cannot be read (e.g. stick removed). */
export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}
