/** Kiosk-side client for the photo API. Retries transient failures; the server dedupes by session. */

export interface UploadResult {
  token: string;
  path: string;
  expiresAt: string;
  duplicate: boolean;
}

export interface UploadInput {
  blob: Blob;
  sessionId: string;
  frameId: string;
}

const RETRY_DELAYS_MS = [0, 1500, 4000];

export async function uploadFinalImage(
  input: UploadInput,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<UploadResult> {
  let lastError: unknown = null;
  for (const delay of RETRY_DELAYS_MS) {
    if (delay) await sleep(delay);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetchImpl("/api/photos", {
        method: "POST",
        headers: {
          "content-type": input.blob.type || "image/jpeg",
          "x-session-id": input.sessionId,
          "x-frame-id": input.frameId,
        },
        body: input.blob,
        signal: controller.signal,
      });
      if (response.ok) return (await response.json()) as UploadResult;
      // 4xx means the request itself is wrong; retrying will not help.
      if (response.status >= 400 && response.status < 500) {
        throw Object.assign(new Error(`Upload rejected (${response.status})`), { fatal: true });
      }
      lastError = new Error(`Upload failed (${response.status})`);
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal) throw err;
      lastError = err;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Upload failed");
}

export async function sendWallConsent(
  token: string,
  consent: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl("/api/photos/consent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, consent }),
  });
  if (!response.ok) throw new Error(`Consent failed (${response.status})`);
}
