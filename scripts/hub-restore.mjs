#!/usr/bin/env node
/**
 * Restore the hub from its USB backup (desktop icon "백업에서 복구", RUNBOOK 7).
 *
 *   node scripts/hub-restore.mjs <USB folder> [--data .data] [--yes]
 *
 * <USB folder> is HUB_BACKUP_DIR (the folder that contains ftl-backup/). The hub must be off.
 * The data folder defaults to FTL_DATA_DIR from .env.local (else .data).
 * Nothing is deleted: an existing data folder is first renamed to
 * "<data>.before-restore-<time>", so a wrong restore can be undone by renaming it back.
 */
import { cp, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readEnvFile } from "./hub-start.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const exists = (p) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** The backup folder inside `dir` (dir/ftl-backup, or dir itself if it is that folder). */
export async function findBackup(dir) {
  for (const candidate of [path.join(dir, "ftl-backup"), dir])
    if (await exists(path.join(candidate, "db.json"))) return candidate;
  return null;
}

/**
 * Copy the backup into `dataDir`. Returns what was restored and where the old data went.
 * Throws when the backup is missing or its database cannot be read.
 */
export async function restoreBackup({ backupDir, dataDir, now = new Date() }) {
  const source = await findBackup(backupDir);
  if (!source) throw new Error(`no backup found in ${backupDir}`);
  const db = JSON.parse(await readFile(path.join(source, "db.json"), "utf8"));
  if (db.version !== 2 && db.version !== 3) throw new Error("backup database version unknown");

  let movedAside = null;
  if (await exists(dataDir)) {
    movedAside = `${dataDir}.before-restore-${now.toISOString().replace(/[:.]/g, "-")}`;
    await rename(dataDir, movedAside);
  }
  await cp(path.join(source, "db.json"), path.join(dataDir, "db.json"));
  if (await exists(path.join(source, "objects")))
    await cp(path.join(source, "objects"), path.join(dataDir, "objects"), { recursive: true });

  let marker = null;
  try {
    marker = JSON.parse(await readFile(path.join(source, "backup.json"), "utf8"));
  } catch {
    // older or partial backup: the database alone still restores
  }
  return {
    photos: (db.photos ?? []).filter((p) => !p.deletedAt).length,
    backedUpAt: marker?.at ?? null,
    movedAside,
  };
}

async function hubIsRunning(port = 3000) {
  try {
    await fetch(`http://127.0.0.1:${port}/kiosk/enroll`, { redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const backupDir = args.find((a) => !a.startsWith("--"));
  const configured = readEnvFile(path.join(ROOT, ".env.local")).FTL_DATA_DIR || ".data";
  const dataArg = args.includes("--data") ? args[args.indexOf("--data") + 1] : configured;
  const dataDir = path.resolve(ROOT, dataArg);
  if (!backupDir) {
    console.log("사용법: node scripts/hub-restore.mjs <USB 백업 폴더> [--data .data] [--yes]");
    process.exit(2);
  }
  if (await hubIsRunning()) {
    console.log("허브가 켜져 있어요. 검은 허브 창을 먼저 닫은 뒤 다시 실행하세요.");
    process.exit(1);
  }
  const source = await findBackup(path.resolve(backupDir));
  if (!source) {
    console.log(`백업을 찾지 못했어요: ${backupDir}\nUSB가 꽂혀 있는지, 폴더가 맞는지 확인하세요.`);
    process.exit(1);
  }
  if (!args.includes("--yes")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `${source} 의 백업으로 ${dataDir} 를 바꿉니다. 지금 데이터는 지우지 않고 옆에 옮겨 둡니다.\n계속할까요? (y/N) `,
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.log("취소했어요.");
      return;
    }
  }
  const r = await restoreBackup({ backupDir: path.resolve(backupDir), dataDir });
  console.log(
    `복구했어요. 사진 ${r.photos}장 (백업 시각 ${r.backedUpAt ?? "알 수 없음"}).` +
      (r.movedAside ? `\n이전 데이터는 여기 있어요: ${r.movedAside}` : "") +
      "\n이제 '허브와 부스 시작'을 실행하세요.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`복구하지 못했어요: ${err.message}`);
    process.exit(1);
  });
}
