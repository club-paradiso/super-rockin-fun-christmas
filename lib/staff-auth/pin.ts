import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Hub staff login (FTL_ROLE=hub): name + 6-digit PIN, checked against the hub's own staff list.
 * Pure helpers: hashing, PIN rules and the signed session cookie. Request handling lives in
 * ./server.ts.
 *
 * Session cookie: `s1.<userId>.<issuedAt>.<expiresAt>.<pinSetAt>.<hmac>` (issuedAt/expiresAt in
 * unix seconds, pinSetAt in unix milliseconds). The MAC
 * key is derived from KIOSK_SESSION_SECRET with a staff-only label, so a kiosk cookie can never
 * verify as a staff cookie or the other way round. Authority still needs an active staff row
 * whose PIN has not changed since (`pinSetAt`), so deactivation and PIN resets take effect at once.
 */
export const STAFF_COOKIE = "ftl_staff";

export const PIN_LENGTH = 6;

/** scrypt cost. ~50 ms per check on a laptop; with rate limits this makes guessing slow. */
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 32 } as const;

/** Why a PIN is refused, in staff-facing Korean. Null = acceptable. */
export function pinProblem(pin: string): string | null {
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) return `PIN은 숫자 ${PIN_LENGTH}자리예요.`;
  if (/^(\d)\1+$/.test(pin)) return "같은 숫자만 반복한 PIN은 쓸 수 없어요.";
  const digits = [...pin].map(Number);
  const step = digits[1]! - digits[0]!;
  if (Math.abs(step) === 1 && digits.every((d, i) => i === 0 || d - digits[i - 1]! === step))
    return "123456처럼 이어지는 숫자는 쓸 수 없어요.";
  return null;
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

export function verifyPin(pin: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || !expected.length)
    return false;
  const actual = scryptSync(pin, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(actual, expected);
}

export interface StaffSessionClaims {
  userId: string;
  issuedAt: number;
  expiresAt: number;
  /** When the PIN this session was opened with was set (unix milliseconds). */
  pinSetAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mac(secret: string, payload: string): string {
  const key = createHmac("sha256", secret).update("ftl-staff-session-v1").digest();
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function signStaffSession(secret: string, c: StaffSessionClaims): string {
  const payload = `s1.${c.userId}.${c.issuedAt}.${c.expiresAt}.${c.pinSetAt}`;
  return `${payload}.${mac(secret, payload)}`;
}

export function verifyStaffSession(
  secret: string,
  value: string | null | undefined,
  nowSec: number,
): StaffSessionClaims | null {
  if (!value || value.length > 256) return null;
  const parts = value.split(".");
  if (parts.length !== 6 || parts[0] !== "s1") return null;
  const expected = Buffer.from(mac(secret, parts.slice(0, 5).join(".")));
  const given = Buffer.from(parts[5]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const [userId, iat, exp, pinAt] = parts.slice(1, 5) as [string, string, string, string];
  if (!UUID.test(userId)) return null;
  const issuedAt = Number(iat);
  const expiresAt = Number(exp);
  const pinSetAt = Number(pinAt);
  if (![issuedAt, expiresAt, pinSetAt].every(Number.isInteger)) return null;
  if (expiresAt <= nowSec || issuedAt > nowSec + 60) return null;
  return { userId, issuedAt, expiresAt, pinSetAt };
}

/** Integer milliseconds, so the value round-trips through the cookie unchanged. */
export function pinSetAtMs(setAt: string): number {
  return Date.parse(setAt);
}
