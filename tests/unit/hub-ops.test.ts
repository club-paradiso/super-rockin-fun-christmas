// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKUP_FOLDER, freeBytes, readBackupMarker, runBackup } from "@/lib/ops/backup";
import {
  createLocalBackend,
  forgetLocalBackendsForTests,
  snapshotLocalBackend,
} from "@/lib/storage/local-backend";
import { PhotoService } from "@/lib/storage/photo-service";
import {
  browserCandidates,
  kioskArgs,
  lanAddresses,
  readEnvFile,
  restartDelay,
} from "../../scripts/hub-start.mjs";
import { findBackup, restoreBackup } from "../../scripts/hub-restore.mjs";
import { JPEG, uuid } from "../helpers/images";

/**
 * Phase 2-6 operations tools: USB backup (a mirror that also forgets deleted photos), restore,
 * and the pure parts of the hub launcher.
 */
let tmp: string;
let dataDir: string;
let usb: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "ftl-ops-"));
  dataDir = path.join(tmp, "data");
  usb = path.join(tmp, "usb");
  await mkdir(usb);
});
afterEach(async () => {
  forgetLocalBackendsForTests();
  await rm(tmp, { recursive: true, force: true });
});

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

async function hubWithPhotos(n: number) {
  const backend = createLocalBackend(dataDir);
  const service = new PhotoService(backend, { linkTtlHours: 24, retentionDays: 30 });
  const photos = [];
  for (let i = 0; i < n; i++)
    photos.push(
      await service.put({
        sessionId: uuid(),
        kioskId: null,
        frameId: "starlight-strip",
        mime: "image/jpeg",
        data: JPEG,
      }),
    );
  return { backend, service, photos };
}
const backup = () =>
  runBackup({ dataDir, backupDir: usb, snapshot: () => snapshotLocalBackend(dataDir) });

describe("USB backup", () => {
  it("copies the database and every image, then only what changed", async () => {
    const { photos } = await hubWithPhotos(3);
    const first = await backup();
    expect(first.copied).toBe(first.files);
    expect(first.files).toBeGreaterThanOrEqual(3);
    const db = JSON.parse(await readFile(path.join(usb, BACKUP_FOLDER, "db.json"), "utf8"));
    expect(db.photos.map((p: { id: string }) => p.id).sort()).toEqual(
      photos.map((p) => p.photo.id).sort(),
    );
    expect(await readBackupMarker(usb)).toMatchObject({ version: 1, files: first.files });
    expect(await exists(path.join(usb, BACKUP_FOLDER, "README.txt"))).toBe(true);

    const again = await backup();
    expect(again).toMatchObject({ copied: 0, removed: 0, files: first.files });
  });

  it("a photo deleted on the hub disappears from the backup on the next run", async () => {
    const { backend, service, photos } = await hubWithPhotos(2);
    await backup();
    const gone = photos[0]!.photo.id;
    const row = (await backend.photos.getById(gone))!;
    expect(await exists(path.join(usb, BACKUP_FOLDER, "objects", row.objectPath))).toBe(true);

    await service.moderate(gone, "delete", uuid());
    const r = await backup();
    expect(r.removed).toBeGreaterThanOrEqual(1);
    expect(await exists(path.join(usb, BACKUP_FOLDER, "objects", row.objectPath))).toBe(false);
    const db = JSON.parse(await readFile(path.join(usb, BACKUP_FOLDER, "db.json"), "utf8"));
    expect(db.photos.find((p: { id: string }) => p.id === gone).moderationStatus).toBe("DELETED");
  });

  it("refuses to run when the USB folder is not there (never writes to the laptop instead)", async () => {
    await hubWithPhotos(1);
    const missing = path.join(tmp, "not-plugged-in");
    await expect(
      runBackup({ dataDir, backupDir: missing, snapshot: () => snapshotLocalBackend(dataDir) }),
    ).rejects.toThrow(/USB stick/);
    expect(await exists(missing)).toBe(false);
    expect(await readBackupMarker(missing)).toBeNull();
  });

  it("reports free space, or null for a missing disk", async () => {
    expect(await freeBytes(tmp)).toBeGreaterThan(0);
    expect(await freeBytes(path.join(tmp, "nope"))).toBeNull();
  });
});

describe("restore from the USB backup", () => {
  it("brings back photos and images on a new laptop, keeping old data aside, never deleting", async () => {
    const { photos, backend } = await hubWithPhotos(2);
    await backup();
    const original = (await backend.photos.getById(photos[0]!.photo.id))!;
    forgetLocalBackendsForTests();

    // The "new laptop" already had something in its data folder.
    const newData = path.join(tmp, "new-laptop-data");
    await mkdir(newData);
    await writeFile(path.join(newData, "db.json"), '{"version":3,"photos":[]}');

    expect(await findBackup(usb)).toBe(path.join(usb, BACKUP_FOLDER));
    const r = await restoreBackup({
      backupDir: usb,
      dataDir: newData,
      now: new Date("2026-12-01T10:00:00Z"),
    });
    expect(r.photos).toBe(2);
    expect(r.backedUpAt).not.toBeNull();
    expect(r.movedAside).toMatch(/new-laptop-data\.before-restore-2026-12-01T10-00-00-000Z$/);
    expect(await readFile(path.join(r.movedAside!, "db.json"), "utf8")).toContain('"photos":[]');

    // The restored hub serves the same photos.
    const restored = createLocalBackend(newData);
    expect(await restored.photos.getById(original.id)).toMatchObject({
      sessionId: original.sessionId,
      tokenHash: original.tokenHash,
    });
    expect(await restored.objects.get(original.objectPath)).not.toBeNull();
  });

  it("refuses a folder without a backup", async () => {
    await expect(restoreBackup({ backupDir: tmp, dataDir })).rejects.toThrow(/no backup/);
    expect(await readdir(tmp)).not.toContain("data.before-restore");
  });
});

describe("hub launcher (pure parts)", () => {
  it("restart delays grow to 30 s", () => {
    expect([1, 2, 3, 4, 5, 9].map(restartDelay)).toEqual([
      1_000, 2_000, 5_000, 10_000, 30_000, 30_000,
    ]);
  });

  it("prints LAN addresses only (no loopback, IPv6 or link-local)", () => {
    expect(
      lanAddresses({
        lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
        wifi: [
          { family: "IPv4", address: "192.168.0.10", internal: false },
          { family: "IPv6", address: "fe80::1", internal: false },
        ],
        eth: [{ family: "IPv4", address: "169.254.3.4", internal: false }],
      }),
    ).toEqual(["192.168.0.10"]);
  });

  it("finds Chrome before Edge on Windows and macOS", () => {
    const win = browserCandidates("win32", {
      PROGRAMFILES: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
    });
    expect(win[0]).toBe("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    expect(win.at(-1)).toMatch(/msedge\.exe$/);
    expect(browserCandidates("darwin")[0]).toMatch(/Google Chrome$/);
  });

  it("opens the booth full screen with its own profile", () => {
    expect(kioskArgs("http://localhost:3000/kiosk", "/p")).toEqual(
      expect.arrayContaining([
        "--kiosk",
        "--app=http://localhost:3000/kiosk",
        "--user-data-dir=/p",
      ]),
    );
  });

  it("reads .env.local the way the hub needs it", async () => {
    const f = path.join(tmp, ".env.local");
    await writeFile(f, '# comment\nFTL_ROLE=hub\r\nFTL_DATA_DIR=".data"\nEMPTY=\n');
    expect(readEnvFile(f)).toEqual({ FTL_ROLE: "hub", FTL_DATA_DIR: ".data", EMPTY: "" });
    expect(readEnvFile(path.join(tmp, "missing"))).toEqual({});
  });
});
