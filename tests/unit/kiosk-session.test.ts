// @vitest-environment node
import { describe, expect, it } from "vitest";
import { signKioskSession, verifyKioskSession } from "@/lib/kiosk-auth/session";

const SECRET = "k".repeat(48);
const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const claims = { kioskId: ID, issuedAt: 1_000, expiresAt: 2_000 };

describe("kiosk session cookie", () => {
  it("round-trips", () => {
    expect(verifyKioskSession(SECRET, signKioskSession(SECRET, claims), 1_500)).toEqual(claims);
  });

  it("rejects expiry, tampering, other secrets, and junk", () => {
    const value = signKioskSession(SECRET, claims);
    expect(verifyKioskSession(SECRET, value, 2_000)).toBeNull();
    expect(
      verifyKioskSession(SECRET, value.replace(ID, "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff"), 1_500),
    ).toBeNull();
    expect(verifyKioskSession(SECRET, value.replace(".2000.", ".9999."), 1_500)).toBeNull();
    expect(verifyKioskSession("z".repeat(48), value, 1_500)).toBeNull();
    expect(verifyKioskSession(SECRET, "v1.x.y.z.w", 1_500)).toBeNull();
    expect(verifyKioskSession(SECRET, null, 1_500)).toBeNull();
  });
});
