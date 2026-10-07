/** Random session id (UUID v4). Doubles as the upload idempotency key. */
export function newSessionId(): string {
  return crypto.randomUUID();
}

/** Release object URLs held by a finished session so a long event day does not leak memory. */
export function releaseUrls(
  urls: Iterable<string | null | undefined>,
  revoke = URL.revokeObjectURL,
) {
  for (const url of urls) if (url) revoke(url);
}
