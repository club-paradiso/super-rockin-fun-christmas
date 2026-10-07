import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalPhotoStore } from "@/lib/storage/local-store";
import { hashToken, isWellFormedToken, newToken } from "@/lib/storage/token";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const SESSION = "11111111-2222-4333-8444-555555555555";

let dir: string;
let now: Date;
const store = () => new LocalPhotoStore({ rootDir: dir, linkTtlHours: 72, now: () => now });

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-store-"));
  now = new Date("2026-12-24T10:00:00Z");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("tokens", () => {
  it("are random, URL-safe and well formed", () => {
    const tokens = new Set(Array.from({ length: 500 }, newToken));
    expect(tokens.size).toBe(500);
    for (const t of tokens) expect(isWellFormedToken(t)).toBe(true);
    expect(isWellFormedToken("../../etc/passwd")).toBe(false);
  });
});

describe("LocalPhotoStore", () => {
  it("stores and reads back a photo by token", async () => {
    const s = store();
    const { token, record, duplicate } = await s.put({
      sessionId: SESSION,
      frameId: "starlight-strip",
      mime: "image/jpeg",
      data: JPEG,
    });
    expect(duplicate).toBe(false);
    expect(record.wall).toBe("none");
    expect(record.expiresAt).toBe("2026-12-27T10:00:00.000Z");
    const read = await s.read(token);
    expect(Array.from(read!.data)).toEqual(Array.from(JPEG));
  });

  it("never writes the raw token to disk", async () => {
    const { token } = await store().put({
      sessionId: SESSION,
      frameId: "f",
      mime: "image/jpeg",
      data: JPEG,
    });
    const photos = await readdir(path.join(dir, "photos"));
    expect(photos.some((f) => f.includes(token))).toBe(false);
    expect(photos.some((f) => f.startsWith(hashToken(token)))).toBe(true);
  });

  it("is idempotent per session: a retried upload returns the same link", async () => {
    const s = store();
    const a = await s.put({ sessionId: SESSION, frameId: "f", mime: "image/jpeg", data: JPEG });
    const b = await s.put({ sessionId: SESSION, frameId: "f", mime: "image/jpeg", data: JPEG });
    expect(b.token).toBe(a.token);
    expect(b.duplicate).toBe(true);
    expect(
      (await readdir(path.join(dir, "photos"))).filter((f) => f.endsWith(".img")),
    ).toHaveLength(1);
  });

  it("expires links", async () => {
    const s = store();
    const { token } = await s.put({
      sessionId: SESSION,
      frameId: "f",
      mime: "image/jpeg",
      data: JPEG,
    });
    now = new Date("2026-12-27T10:00:01Z");
    expect(await s.get(token)).toBeNull();
    expect(await s.read(token)).toBeNull();
  });

  it("returns null for unknown or malformed tokens", async () => {
    expect(await store().get(newToken())).toBeNull();
    expect(await store().get("bad")).toBeNull();
  });

  it("wall consent queues for moderation without touching the download", async () => {
    const s = store();
    const { token } = await s.put({
      sessionId: SESSION,
      frameId: "f",
      mime: "image/jpeg",
      data: JPEG,
    });
    expect((await s.setWallConsent(token, true))!.wall).toBe("PENDING");
    expect(await s.read(token)).not.toBeNull();
    expect((await s.setWallConsent(token, false))!.wall).toBe("none");
    expect(await s.read(token)).not.toBeNull();
  });
});
