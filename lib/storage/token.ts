import { createHash, randomBytes } from "node:crypto";

/** 192 random bits, base64url → 32 chars. Unguessable and non-sequential. */
export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/**
 * Tokens are only stored hashed, so a leaked database or file listing does not reveal working
 * download links. SHA-256 without salt is fine here: the input already has 192 bits of entropy.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
