// @vitest-environment node
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { JPEG, uuid } from "../helpers/images";

/** "지금 백업" and the overview's backup / disk status on a hub (real route handlers). */
const ORIGIN = "http://192.168.0.10:3000";
let dir: string;
let usb: string;
let staff = "";

const post = (url: string, body: unknown, cookie?: string) =>
  new Request(`${ORIGIN}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
const noParams = { params: Promise.resolve({}) };

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-backup-api-"));
  usb = path.join(dir, "usb");
  await mkdir(usb);
  Object.assign(process.env, {
    FTL_ROLE: "hub",
    FTL_DATA_DIR: path.join(dir, "data"),
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: "s".repeat(48),
    HUB_BACKUP_DIR: usb,
    HUB_DISK_WARN_MB: "1",
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { addPinStaffMember } = await import("@/lib/ops/staff-admin");
  const id = (await addPinStaffMember("책임자", "482913", null)).userId;
  const { POST } = await import("@/app/api/admin/auth/pin/route");
  staff = cookieOf(await POST(post("/api/admin/auth/pin", { userId: id, pin: "482913" })));
  const { getPhotoService } = await import("@/lib/storage/server");
  await getPhotoService().put({
    sessionId: uuid(),
    kioskId: null,
    frameId: "starlight-strip",
    mime: "image/jpeg",
    data: JPEG,
  });
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function overview() {
  const { getOverview } = await import("@/lib/ops/admin");
  return (await getOverview()).ops!;
}

describe("hub backup through the staff API", () => {
  it("before the first run the overview says so", async () => {
    const ops = await overview();
    expect(ops.backup).toMatchObject({ configured: true, lastAt: null, stale: true, error: null });
    expect(ops.disk.dataFree).toBeGreaterThan(0);
  });

  it("staff only; then 지금 백업 copies and the overview shows it", async () => {
    const { POST } = await import("@/app/api/admin/backup/route");
    expect((await POST(post("/api/admin/backup", {}), noParams)).status).toBe(401);
    const res = await POST(post("/api/admin/backup", {}, staff), noParams);
    expect(res.status).toBe(200);
    const { files } = (await res.json()) as { files: number };
    expect(files).toBeGreaterThanOrEqual(1);
    const ops = await overview();
    expect(ops.backup.lastAt).not.toBeNull();
    expect(ops.backup).toMatchObject({ files, stale: false, error: null });
    expect(ops.disk.backupFree).toBeGreaterThan(0);
  });

  it("stick pulled out: 503 with the reason, and the overview shows the failure", async () => {
    await rm(usb, { recursive: true, force: true });
    const { POST } = await import("@/app/api/admin/backup/route");
    const res = await POST(post("/api/admin/backup", {}, staff), noParams);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "backup_failed" });
    const ops = await overview();
    expect(ops.backup.error?.message).toMatch(/USB stick/);
    expect(ops.disk.backupFree).toBeNull();
  });
});
