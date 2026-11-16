/**
 * Random session id (UUID v4), also the upload idempotency key.
 * iOS WebKit may provide getRandomValues() even if randomUUID() is absent.
 * Never fall back to Math.random() for a guest's token/idempotency identifier.
 */
export function newSessionId(): string {
  if (typeof crypto === "undefined" || !crypto.getRandomValues)
    throw new Error("Secure random generator unavailable; open the kiosk over HTTPS");
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Release object URLs held by a finished session so a long event day does not leak memory. */
export function releaseUrls(
  urls: Iterable<string | null | undefined>,
  revoke = URL.revokeObjectURL,
) {
  for (const url of urls) if (url) revoke(url);
}
