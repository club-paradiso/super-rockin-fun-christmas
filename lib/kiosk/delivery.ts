import type { QueuedUpload } from "@/lib/offline/queue-store";
import type { ConsentOutcome } from "@/lib/offline/consent-queue";
import type { ConsentScope } from "@/lib/offline/queue-store";
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
    if (response.status === 202) {
      const body = (await response.json()) as Omit<
        Extract<UploadSuccess, { qrPending: true }>,
        "qrPending"
      >;
      return { ok: true, result: { ...body, qrPending: true } };
    }
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

/**
 * One attempt to record the guest's media-wall answer for a session (the ConsentQueue retries).
 * "done" also covers answers the server will never take (submissions paused → 409, photo gone →
 * 404, bad request → 400): retrying those would not change anything.
 *
 * `scope` "public" says the consent screen showed the public-wall notice (D86). The server
 * records it only while the public wall is on; it is never sent with a "no".
 */
export async function sendWallConsent(
  sessionId: string,
  consent: boolean,
  scope?: ConsentScope,
  fetchImpl: typeof fetch = fetch,
): Promise<ConsentOutcome> {
  try {
    const response = await fetchImpl("/api/photos/consent", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, consent, ...(consent && scope ? { scope } : {}) }),
    });
    if (response.ok) return "done";
    if (response.status === 401 || response.status === 429 || response.status >= 500)
      return "retry";
    return "done";
  } catch {
    return "retry";
  }
}

/**
 * Hub + cloud: ask whether this session's QR copy has reached the cloud. The link, or null while
 * it is still pending (or on any error: the caller simply asks again).
 */
export async function requestQr(
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ token: string; url: string; expiresAt: string } | null> {
  try {
    const response = await fetchImpl("/api/photos/qr", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (response.status !== 200) return null;
    const body = (await response.json()) as { token?: string; url?: string; expiresAt?: string };
    return body.token && body.url && body.expiresAt
      ? { token: body.token, url: body.url, expiresAt: body.expiresAt }
      : null;
  } catch {
    return null;
  }
}

/**
 * One attempt to send the session video (D72) for a photo the server already has.
 * "done": stored (or was already). "retry": worth one more try (offline, 5xx, 429, and 404 —
 * the photo may not have landed yet). "dropped": the server will never take it.
 * The caller gives up quietly either way: the guest's photo and QR never depend on this.
 */
export type VideoOutcome = "done" | "retry" | "dropped";

export async function uploadVideoOnce(
  sessionId: string,
  video: { mime: string; blob: Blob },
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30_000,
): Promise<VideoOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl("/api/photos/video", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": video.mime, "x-session-id": sessionId },
      body: video.blob,
      signal: controller.signal,
    });
    if (response.ok) return "done";
    const status = response.status;
    return status === 404 || status === 429 || status >= 500 ? "retry" : "dropped";
  } catch {
    return "retry";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a session video with a few spaced tries, then give up. Not queued offline on purpose
 * (D72): a video is up to 3.5 MB and only nice to have, and the durable queue is reserved for
 * the photo and the wall answer. Returns whether the server has it.
 */
export async function deliverVideo(
  sessionId: string,
  video: { mime: string; blob: Blob },
  opts: {
    send?: (sessionId: string, video: { mime: string; blob: Blob }) => Promise<VideoOutcome>;
    delaysMs?: number[];
    sleep?: (ms: number) => Promise<void>;
    warn?: (message: string) => void;
  } = {},
): Promise<boolean> {
  const send = opts.send ?? ((id, v) => uploadVideoOnce(id, v));
  const delays = opts.delaysMs ?? [3_000, 10_000];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  for (let attempt = 0; ; attempt++) {
    const outcome = await send(sessionId, video);
    if (outcome === "done") return true;
    if (outcome === "dropped" || attempt >= delays.length) {
      // For staff looking at the booth's console; the guest sees nothing about it.
      warn(`session video not sent (${outcome}, ${attempt + 1} tries)`);
      return false;
    }
    await sleep(delays[attempt]!);
  }
}
