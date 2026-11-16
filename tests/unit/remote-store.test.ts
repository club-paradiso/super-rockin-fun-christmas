import { beforeEach, describe, expect, it } from "vitest";
import { TIMING, type SignalMessage } from "@/lib/remote-camera/protocol";
import { MemoryRemoteCameraStore, isOnline, withFreshThumb } from "@/lib/remote-camera/store";
import { toStaffCameraView } from "@/lib/remote-camera/admin";
import { EMPTY_REPORT } from "@/lib/remote-camera/protocol";

const KIOSK = "22222222-2222-4222-8222-222222222222";
const KIOSK_B = "33333333-3333-4333-8333-333333333333";
const HASH = "a".repeat(64);
const t0 = Date.parse("2026-11-16T09:00:00Z");
const iso = (ms: number) => new Date(t0 + ms).toISOString();

let store: MemoryRemoteCameraStore;
beforeEach(() => {
  store = new MemoryRemoteCameraStore();
});

async function pairUp(kioskId = KIOSK, hash = HASH, id = "11111111-1111-4111-8111-111111111111") {
  await store.issueCode({
    kioskId,
    codeHash: hash,
    staffId: "staff-1",
    nowIso: iso(0),
    expiresAtIso: iso(TIMING.pairingCodeTtlMs),
  });
  return store.consumeCode({ codeHash: hash, pairingId: id, name: "Hall cam", nowIso: iso(1000) });
}

describe("pairing codes", () => {
  it("are single use", async () => {
    const first = await pairUp();
    expect(first).toMatchObject({ kioskId: KIOSK, name: "Hall cam", pairedBy: "staff-1" });
    expect(
      await store.consumeCode({
        codeHash: HASH,
        pairingId: "99999999-9999-4999-8999-999999999999",
        name: "x",
        nowIso: iso(2000),
      }),
    ).toBeNull();
  });
  it("expire", async () => {
    await store.issueCode({
      kioskId: KIOSK,
      codeHash: HASH,
      staffId: "s",
      nowIso: iso(0),
      expiresAtIso: iso(60_000),
    });
    expect(
      await store.consumeCode({
        codeHash: HASH,
        pairingId: "11111111-1111-4111-8111-111111111111",
        name: "x",
        nowIso: iso(60_000),
      }),
    ).toBeNull();
  });
  it("are unknown to a wrong guess, in the same way as used or expired ones", async () => {
    expect(
      await store.consumeCode({
        codeHash: "b".repeat(64),
        pairingId: "11111111-1111-4111-8111-111111111111",
        name: "x",
        nowIso: iso(0),
      }),
    ).toBeNull();
  });
  it("a new code for a kiosk kills that kiosk's earlier unused code", async () => {
    await store.issueCode({
      kioskId: KIOSK,
      codeHash: "c".repeat(64),
      staffId: "s",
      nowIso: iso(0),
      expiresAtIso: iso(600_000),
    });
    await store.issueCode({
      kioskId: KIOSK,
      codeHash: HASH,
      staffId: "s",
      nowIso: iso(1),
      expiresAtIso: iso(600_000),
    });
    expect(
      await store.consumeCode({
        codeHash: "c".repeat(64),
        pairingId: "11111111-1111-4111-8111-111111111111",
        name: "x",
        nowIso: iso(2),
      }),
    ).toBeNull();
    expect(
      await store.consumeCode({
        codeHash: HASH,
        pairingId: "11111111-1111-4111-8111-111111111111",
        name: "x",
        nowIso: iso(2),
      }),
    ).not.toBeNull();
  });
});

describe("pairings", () => {
  it("one active camera per kiosk: pairing again replaces the old one", async () => {
    const a = await pairUp(KIOSK, HASH, "11111111-1111-4111-8111-111111111111");
    const b = await pairUp(KIOSK, "d".repeat(64), "44444444-4444-4444-8444-444444444444");
    expect((await store.activeForKiosk(KIOSK))?.id).toBe(b!.id);
    const old = await store.get(a!.id);
    expect(old?.revokedAt).not.toBeNull();
  });
  it("kiosks are independent", async () => {
    await pairUp(KIOSK, HASH);
    await pairUp(KIOSK_B, "e".repeat(64), "55555555-5555-4555-8555-555555555555");
    expect(await store.activeForKiosk(KIOSK)).not.toBeNull();
    expect(await store.activeForKiosk(KIOSK_B)).not.toBeNull();
  });
  it("revoke is immediate, idempotent and records who", async () => {
    const p = (await pairUp())!;
    expect(await store.revoke(p.id, "staff-2", iso(5000))).toBe(true);
    expect(await store.revoke(p.id, "staff-2", iso(6000))).toBe(false);
    expect(await store.get(p.id)).toMatchObject({ revokedBy: "staff-2" });
    expect(await store.activeForKiosk(KIOSK)).toBeNull();
  });
  it("online means a heartbeat within the window, and a revoked camera is never online", async () => {
    const p = (await pairUp())!;
    expect(isOnline(await store.get(p.id), t0 + 2000)).toBe(true);
    expect(isOnline(await store.get(p.id), t0 + 1000 + TIMING.onlineWithinMs + 1)).toBe(false);
    await store.touch(p.id, iso(30_000));
    expect(isOnline(await store.get(p.id), t0 + 31_000)).toBe(true);
    await store.revoke(p.id, "s", iso(32_000));
    expect(isOnline(await store.get(p.id), t0 + 33_000)).toBe(false);
  });
  it("a staff test thumbnail disappears after two minutes", async () => {
    const report = {
      ...EMPTY_REPORT,
      state: "live" as const,
      testThumb: "data:image/jpeg;base64,AAAA",
      testAt: iso(0),
    };
    expect(withFreshThumb(report, t0 + 60_000).testThumb).not.toBeNull();
    expect(withFreshThumb(report, t0 + 121_000).testThumb).toBeNull();
    const p = (await pairUp())!;
    await store.setReport(p.id, report, iso(1000));
    const view = toStaffCameraView((await store.get(p.id))!, "Main", t0 + 200_000);
    expect(view.report.testThumb).toBeNull();
    expect(view.online).toBe(false);
    expect(view.report.state).toBe("offline");
    // the view never carries anything that could authorize a call
    expect(JSON.stringify(view)).not.toMatch(/hash|secret|cookie/i);
  });
});

describe("mailbox", () => {
  const offer: SignalMessage = { t: "offer", sid: "abcdef123456", sdp: "v=0" };
  it("delivers in order, only to the addressee, only for its own pairing, and only once per cursor", async () => {
    const a = (await pairUp(KIOSK, HASH, "11111111-1111-4111-8111-111111111111"))!;
    const b = (await pairUp(KIOSK_B, "e".repeat(64), "55555555-5555-4555-8555-555555555555"))!;
    const s1 = await store.push({
      pairingId: a.id,
      kioskId: KIOSK,
      from: "kiosk",
      to: "camera",
      message: offer,
      nowIso: iso(10),
    });
    await store.push({
      pairingId: a.id,
      kioskId: KIOSK,
      from: "camera",
      to: "kiosk",
      message: { t: "bye", sid: "abcdef123456" },
      nowIso: iso(11),
    });
    await store.push({
      pairingId: b.id,
      kioskId: KIOSK_B,
      from: "kiosk",
      to: "camera",
      message: offer,
      nowIso: iso(12),
    });
    const forCamera = await store.poll({
      pairingId: a.id,
      to: "camera",
      afterSeq: 0,
      nowIso: iso(20),
    });
    expect(forCamera.map((m) => m.seq)).toEqual([s1]);
    expect(
      await store.poll({ pairingId: a.id, to: "camera", afterSeq: s1, nowIso: iso(20) }),
    ).toEqual([]);
    expect(
      (await store.poll({ pairingId: a.id, to: "kiosk", afterSeq: 0, nowIso: iso(20) })).length,
    ).toBe(1);
  });
  it("forgets messages after their time to live", async () => {
    const a = (await pairUp())!;
    await store.push({
      pairingId: a.id,
      kioskId: KIOSK,
      from: "kiosk",
      to: "camera",
      message: offer,
      nowIso: iso(0),
    });
    expect(
      await store.poll({
        pairingId: a.id,
        to: "camera",
        afterSeq: 0,
        nowIso: iso(TIMING.signalTtlMs + 1),
      }),
    ).toEqual([]);
    await store.purge(iso(TIMING.signalTtlMs + 1));
  });
  it("is bounded per pairing", async () => {
    const a = (await pairUp())!;
    for (let i = 0; i < 500; i++)
      await store.push({
        pairingId: a.id,
        kioskId: KIOSK,
        from: "kiosk",
        to: "camera",
        message: { t: "ice", sid: "abcdef123456", candidate: null },
        nowIso: iso(i),
      });
    const all = await store.poll({
      pairingId: a.id,
      to: "camera",
      afterSeq: 0,
      nowIso: iso(600),
      limit: 1000,
    });
    expect(all.length).toBeLessThanOrEqual(300);
  });
  it("revoking a pairing clears its mailbox", async () => {
    const a = (await pairUp())!;
    await store.push({
      pairingId: a.id,
      kioskId: KIOSK,
      from: "kiosk",
      to: "camera",
      message: offer,
      nowIso: iso(1),
    });
    await store.revoke(a.id, "s", iso(2));
    expect(
      await store.poll({ pairingId: a.id, to: "camera", afterSeq: 0, nowIso: iso(3) }),
    ).toEqual([]);
  });
});
