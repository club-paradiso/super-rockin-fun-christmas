import type { QueuedUpload } from "@/lib/offline/queue-store";
import type { UploadOutcome, UploadSuccess } from "@/lib/offline/upload-queue";

/**
 * Kiosk → server photo upload. One attempt; the offline queue owns retries. Authentication is
 * the HttpOnly kiosk cookie (sent automatically, same-origin) — no secret in JavaScript.
 */
export async function uploadOnce(
  entry: Pick<QueuedUpload, "sessionId" | "frameId" | "mime" | "data">,
  queueDepth: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<UploadOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl("/api/photos", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": entry.mime,
        "x-session-id": entry.sessionId,
        "x-frame-id": entry.frameId,
        "x-queue-depth": String(queueDepth),
      },
      body: entry.data,
      signal: controller.signal,
    });
    const status = response.status;
    if (response.ok) return { ok: true, result: (await response.json()) as UploadSuccess };
    const message = `upload failed (${status})`;
    if (status === 401) return { ok: false, kind: "auth", status, message };
    if (status === 409) return { ok: false, kind: "conflict", status, message };
    if (status === 400 || status === 403 || status === 413 || status === 415) {
      return { ok: false, kind: "rejected", status, message };
    }
    return { ok: false, kind: "server", status, message };
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort, retried a few times. A failure never affects the guest's download link. */
export async function sendWallConsent(
  token: string,
  consent: boolean,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  for (const delay of [0, 2_000, 8_000]) {
    if (delay) await sleep(delay);
    try {
      const response = await fetchImpl("/api/photos/consent", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, consent }),
      });
      if (response.ok) return true;
      if (response.status < 500 && response.status !== 429) return false;
    } catch {
      // network: retry
    }
  }
  return false;
}
