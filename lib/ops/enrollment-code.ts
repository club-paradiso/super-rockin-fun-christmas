import { createHash, randomInt } from "node:crypto";

/**
 * One-time kiosk enrollment codes, e.g. "K7QM-3XRP".
 * 31-symbol alphabet without look-alikes (0/O, 1/I/L) → 8 symbols ≈ 39.6 bits. Codes live
 * 15 minutes, work once, are rate-limited per IP, and are stored only as SHA-256 hashes.
 */
export const ENROLLMENT_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const ENROLLMENT_CODE_TTL_MINUTES = 15;

export function generateEnrollmentCode(): string {
  let raw = "";
  for (let i = 0; i < 8; i++)
    raw += ENROLLMENT_CODE_ALPHABET[randomInt(ENROLLMENT_CODE_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Uppercase, drop spaces/hyphens. Null unless it is exactly 8 alphabet symbols. */
export function normalizeEnrollmentCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== 8) return null;
  for (const ch of s) if (!ENROLLMENT_CODE_ALPHABET.includes(ch)) return null;
  return s;
}

export function hashEnrollmentCode(normalized: string): string {
  return createHash("sha256").update(`ftl-enroll:${normalized}`).digest("hex");
}
