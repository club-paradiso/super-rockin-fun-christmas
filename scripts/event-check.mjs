#!/usr/bin/env node
/**
 * After the event: what is still on this laptop and the USB stick? (RUNBOOK 8, read-only.)
 *
 *   node scripts/event-check.mjs [--data .data] [--backup <HUB_BACKUP_DIR>]
 *
 * Looks at, and never changes:
 *   - the hub database: photos not yet deleted, cloud copies whose delete has not gone out yet
 *   - photo files in the data folder, and in old "<data>.before-restore-*" folders
 *   - the USB backup mirror (<HUB_BACKUP_DIR>/ftl-backup)
 *   - the booth browser profile (.browser/), which can hold photos still waiting to upload
 *
 * Prints a report and exits 0 when nothing is left, 1 otherwise. Defaults come from .env.local.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readEnvFile } from "./hub-start.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Files and bytes under `dir` (0/0 when it does not exist). */
export async function folderSize(dir) {
  let files = 0;
  let bytes = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { files, bytes };
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await folderSize(full);
      files += sub.files;
      bytes += sub.bytes;
    } else if (e.isFile()) {
      files++;
      bytes += (await stat(full)).size;
    }
  }
  return { files, bytes };
}

/** Photos still live, and cloud copies not yet confirmed deleted, in a hub db.json. */
export async function databaseLeft(dbFile) {
  let db;
  try {
    db = JSON.parse(await readFile(dbFile, "utf8"));
  } catch {
    return null;
  }
  const photos = db.photos ?? [];
  const live = photos.filter((p) => p.moderationStatus !== "DELETED" && !p.deletedAt);
  const cloud = photos.filter((p) => p.cloud && p.cloud.state !== "DELETED");
  return { live: live.length, cloudNotDeleted: cloud.length };
}

/** Everything the check looks at, as numbers. */
export async function eventCheck({ dataDir, backupDir, browserDir }) {
  const parent = path.dirname(dataDir);
  const base = path.basename(dataDir);
  const asides = (await readdir(parent).catch(() => []))
    .filter((n) => n.startsWith(`${base}.before-restore-`))
    .map((n) => path.join(parent, n));
  const asideFiles = { files: 0, bytes: 0 };
  for (const d of asides) {
    const s = await folderSize(path.join(d, "objects"));
    asideFiles.files += s.files;
    asideFiles.bytes += s.bytes;
  }
  const mirror = backupDir ? path.join(backupDir, "ftl-backup") : null;
  return {
    database: await databaseLeft(path.join(dataDir, "db.json")),
    photoFiles: await folderSize(path.join(dataDir, "objects")),
    restoreAsides: { folders: asides, ...asideFiles },
    backup: mirror
      ? {
          folder: mirror,
          database: await databaseLeft(path.join(mirror, "db.json")),
          photoFiles: await folderSize(path.join(mirror, "objects")),
        }
      : null,
    browserProfile: await folderSize(browserDir),
  };
}

/** True when nothing that could hold a guest photo is left. */
export function isClean(r) {
  return (
    (r.database?.live ?? 0) === 0 &&
    (r.database?.cloudNotDeleted ?? 0) === 0 &&
    r.photoFiles.files === 0 &&
    r.restoreAsides.folders.length === 0 &&
    (!r.backup || (r.backup.photoFiles.files === 0 && (r.backup.database?.live ?? 0) === 0)) &&
    r.browserProfile.files === 0
  );
}

const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

function report(r, opts) {
  const lines = [];
  const mark = (ok) => (ok ? "[비었음]" : "[남아 있음]");
  const db = r.database;
  lines.push(`허브 데이터 폴더: ${opts.dataDir}`);
  lines.push(
    db
      ? `  ${mark(db.live === 0)} 지워지지 않은 사진 ${db.live}장`
      : "  [없음] 데이터베이스 파일이 없어요",
  );
  if (db)
    lines.push(
      `  ${mark(db.cloudNotDeleted === 0)} 클라우드 삭제가 아직 안 간 사진 ${db.cloudNotDeleted}장` +
        (db.cloudNotDeleted ? " (허브를 켜고 인터넷에 연결해 두면 보내요)" : ""),
    );
  lines.push(
    `  ${mark(r.photoFiles.files === 0)} 사진 파일 ${r.photoFiles.files}개 (${mb(r.photoFiles.bytes)})`,
  );
  lines.push(
    `  ${mark(r.restoreAsides.folders.length === 0)} 복구 때 옮겨 둔 옛 폴더 ${r.restoreAsides.folders.length}개` +
      (r.restoreAsides.folders.length ? ` (사진 파일 ${r.restoreAsides.files}개)` : ""),
  );
  for (const f of r.restoreAsides.folders) lines.push(`      ${f}`);
  if (r.backup) {
    lines.push(`USB 백업: ${r.backup.folder}`);
    lines.push(
      `  ${mark(r.backup.photoFiles.files === 0)} 사진 파일 ${r.backup.photoFiles.files}개 (${mb(r.backup.photoFiles.bytes)})`,
    );
  } else lines.push("USB 백업: HUB_BACKUP_DIR 없음 (USB는 따로 확인)");
  lines.push(`부스 브라우저 데이터: ${opts.browserDir}`);
  lines.push(
    `  ${mark(r.browserProfile.files === 0)} 파일 ${r.browserProfile.files}개 (${mb(r.browserProfile.bytes)})`,
  );
  lines.push("");
  lines.push(
    isClean(r)
      ? "모두 비었어요. 삭제 기록(날짜, 담당자)을 남기세요."
      : "남은 것이 있어요. RUNBOOK 8번 순서대로 지운 뒤 다시 확인하세요.",
  );
  return lines.join("\n");
}

function parseArgs(argv) {
  const value = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return { data: value("--data"), backup: value("--backup") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = readEnvFile(path.join(ROOT, ".env.local"));
  const dataDir = path.resolve(ROOT, args.data ?? env.FTL_DATA_DIR ?? ".data");
  const backupRaw = args.backup ?? env.HUB_BACKUP_DIR;
  const backupDir = backupRaw ? path.resolve(ROOT, backupRaw) : null;
  const browserDir = path.join(ROOT, ".browser");
  const r = await eventCheck({ dataDir, backupDir, browserDir });
  console.log(report(r, { dataDir, browserDir }));
  process.exit(isClean(r) ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
