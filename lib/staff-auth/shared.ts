import { createHmac, timingSafeEqual } from "node:crypto";
import type { StaffMember } from "@/lib/storage/types";

/**
 * Shared-password administrator session (D84). The password is KIOSK_ENROLL_SECRET, the same one
 * that enrolls a booth: a user decision, so there is no second administrator password. The
 * CREDENTIAL is shared; the SESSION is not:
 *
 * - its own cookie (`ftl_admin`), never read by a kiosk route, and the kiosk cookie is never read
 *   by a staff route;
 * - its own MAC key, derived from KIOSK_SESSION_SECRET with an admin-only label AND the password
 *   itself, so a kiosk or PIN cookie can never verify here, and changing either secret ends every
 *   administrator session at once;
 * - nothing in the cookie but two timestamps. Pure helpers only; request handling is ./server.ts.
 *
 * Cookie: `a1.<issuedAt>.<expiresAt>.<hmac>` (unix seconds).
 */
export const ADMIN_COOKIE = "ftl_admin";

/** Shorter than this and the password is not accepted for /admin (it still enrolls booths). */
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

/**
 * Who a shared-password session acts as. One fixed identity for everyone who knows the password:
 * the audit log shows this id, never a real staff member's. It is not a row in the staff list, so
 * it cannot be deactivated, given a PIN, or confused with a person.
 */
export const SHARED_OPERATOR_ID = "5ca1ab1e-0000-4000-8000-000000000001";

export const SHARED_OPERATOR: StaffMember = {
  userId: SHARED_OPERATOR_ID,
  email: "",
  displayName: "공용 관리자",
  role: "staff",
  active: true,
  createdAt: "2026-11-13T00:00:00.000Z",
};

export function isSharedOperator(userId: string | null | undefined): boolean {
  return userId === SHARED_OPERATOR_ID;
}

export interface AdminSessionClaims {
  issuedAt: number;
  expiresAt: number;
}

function mac(sessionSecret: string, password: string, payload: string): string {
  const key = createHmac("sha256", sessionSecret)
    .update("ftl-admin-shared-session-v1\0")
    .update(password)
    .digest();
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function signAdminSession(
  sessionSecret: string,
  password: string,
  claims: AdminSessionClaims,
): string {
  const payload = `a1.${claims.issuedAt}.${claims.expiresAt}`;
  return `${payload}.${mac(sessionSecret, password, payload)}`;
}

export function verifyAdminSession(
  sessionSecret: string,
  password: string,
  value: string | null | undefined,
  nowSec: number,
): AdminSessionClaims | null {
  if (!value || value.length > 128) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "a1") return null;
  const expected = Buffer.from(mac(sessionSecret, password, parts.slice(0, 3).join(".")));
  const given = Buffer.from(parts[3]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const issuedAt = Number(parts[1]);
  const expiresAt = Number(parts[2]);
  if (!Number.isInteger(issuedAt) || !Number.isInteger(expiresAt)) return null;
  if (expiresAt <= nowSec || issuedAt > nowSec + 60) return null;
  return { issuedAt, expiresAt };
}
