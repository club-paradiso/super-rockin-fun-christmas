// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { signKioskSession } from "@/lib/kiosk-auth/session";
import {
  hashPin,
  pinProblem,
  pinSetAtMs,
  signStaffSession,
  verifyPin,
  verifyStaffSession,
} from "@/lib/staff-auth/pin";
import { createLocalBackend, forgetLocalBackendsForTests } from "@/lib/storage/local-backend";
import { createMemoryBackend } from "@/lib/storage/memory-backend";
import { uuid } from "../helpers/images";

const SECRET = "s".repeat(48);
const NOW = 1_800_000_000;

describe("PIN rules", () => {
  it.each([
    ["482913", null],
    ["12345", /6자리/],
    ["1234567", /6자리/],
    ["12a456", /6자리/],
    ["000000", /같은 숫자/],
    ["777777", /같은 숫자/],
    ["123456", /이어지는/],
    ["987654", /이어지는/],
    ["135791", null],
  ])("%s", (pin, problem) => {
    const result = pinProblem(pin);
    if (problem === null) expect(result).toBeNull();
    else expect(result).toMatch(problem);
  });
});

describe("PIN hashing", () => {
  it("verifies the right PIN only, and never stores the PIN itself", () => {
    const stored = hashPin("482913");
    expect(stored).not.toContain("482913");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(verifyPin("482913", stored)).toBe(true);
    expect(verifyPin("482914", stored)).toBe(false);
    expect(verifyPin("482913", "garbage")).toBe(false);
  });

  it("salts every hash", () => {
    expect(hashPin("482913")).not.toBe(hashPin("482913"));
  });
});

describe("staff session cookie", () => {
  const claims = { userId: uuid(), issuedAt: NOW, expiresAt: NOW + 3600, pinSetAt: NOW - 100 };

  it("round-trips", () => {
    expect(verifyStaffSession(SECRET, signStaffSession(SECRET, claims), NOW + 10)).toEqual(claims);
  });

  it("rejects tampering, another secret, and expiry", () => {
    const value = signStaffSession(SECRET, claims);
    const forged = value.replace(`.${claims.pinSetAt}.`, `.${claims.pinSetAt + 1}.`);
    expect(verifyStaffSession(SECRET, forged, NOW)).toBeNull();
    expect(verifyStaffSession("x".repeat(48), value, NOW)).toBeNull();
    expect(verifyStaffSession(SECRET, value, claims.expiresAt)).toBeNull();
    expect(verifyStaffSession(SECRET, null, NOW)).toBeNull();
  });

  it("a kiosk cookie signed with the same secret is never a staff session", () => {
    const kiosk = signKioskSession(SECRET, {
      kioskId: claims.userId,
      issuedAt: NOW,
      expiresAt: NOW + 3600,
    });
    expect(verifyStaffSession(SECRET, kiosk, NOW)).toBeNull();
    // Same shape as a staff cookie but MACed like a kiosk cookie (no staff key derivation).
    const payload = `s1.${claims.userId}.${NOW}.${NOW + 3600}.${NOW}`;
    const kioskStyleMac = kiosk.split(".").at(-1)!;
    expect(verifyStaffSession(SECRET, `${payload}.${kioskStyleMac}`, NOW)).toBeNull();
  });

  it("pinSetAt keeps milliseconds, so a reset in the same second still counts", () => {
    expect(pinSetAtMs("2026-10-12T10:00:00.999Z")).not.toBe(pinSetAtMs("2026-10-12T10:00:00.000Z"));
  });
});

describe("staff PIN storage", () => {
  it("memory: setPin is audited without the hash, and list/get never expose it", async () => {
    const b = createMemoryBackend();
    const m = await b.staff.upsert({ userId: uuid(), email: "", displayName: "하나" }, null);
    await expect(b.staff.setPin(uuid(), "h", null)).rejects.toThrow(/unknown staff/);
    const pin = await b.staff.setPin(m.userId, "scrypt$hash", m.userId);
    expect(await b.staff.getPin(m.userId)).toEqual(pin);
    expect(JSON.stringify(await b.staff.list())).not.toContain("scrypt$hash");
    expect(JSON.stringify(await b.staff.get(m.userId))).not.toContain("scrypt$hash");
    const [event] = await b.audit.list({ subjectType: "staff", subjectId: m.userId, limit: 1 });
    expect(event).toMatchObject({ action: "set_staff_pin", actorId: m.userId });
    expect(JSON.stringify(event)).not.toContain("scrypt$hash");
  });

  it("local: PINs survive a restart", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ftl-pin-"));
    try {
      const b = createLocalBackend(dir);
      const m = await b.staff.upsert({ userId: uuid(), email: "", displayName: "둘" }, null);
      const pin = await b.staff.setPin(m.userId, "scrypt$stored", null);
      forgetLocalBackendsForTests();
      const again = createLocalBackend(dir);
      expect(await again.staff.getPin(m.userId)).toEqual(pin);
      expect((await again.staff.get(m.userId))?.displayName).toBe("둘");
    } finally {
      forgetLocalBackendsForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
