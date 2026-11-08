import type { PhotoMime } from "@/lib/storage/types";

/** A guest link issued by the cloud copy. Passed straight to the kiosk; the hub never stores it. */
export interface CloudLink {
  token: string;
  url: string;
  expiresAt: string;
}

export type CloudResult<T> =
  | { ok: true; value: T }
  /**
   * retry: worth trying again later (offline, 5xx, 429, wrong secret being fixed).
   * gone: the cloud deleted this copy (its retention, or a delete from the hub); final.
   */
  | { ok: false; retry: boolean; gone?: boolean; message: string };

/** Hub → cloud calls (D43). Everything else about the cloud is out of the hub's reach. */
export interface CloudClient {
  put(photo: {
    sessionId: string;
    frameId: string;
    mime: PhotoMime;
    data: Uint8Array;
  }): Promise<CloudResult<CloudLink>>;
  reissue(sessionId: string): Promise<CloudResult<CloudLink>>;
  remove(sessionId: string): Promise<CloudResult<null>>;
}

/** A QR for the cloud's phone page, issued to the hub (D66). */
export interface CloudUploadSession {
  sessionId: string;
  url: string;
  expiresAt: string;
}

/**
 * Hub ⇄ cloud for phone uploads (D66). The cloud only holds a phone photo until the hub takes
 * it: the hub lists the inbox, downloads each photo, stores it as its own, then acknowledges, and
 * the cloud deletes its copy. Consent travels with the photo (it is the reason it exists);
 * moderation never goes to the cloud.
 */
export interface CloudInboxClient {
  createUploadSession(): Promise<CloudResult<CloudUploadSession>>;
  uploadStatus(sessionId: string): Promise<CloudResult<"waiting" | "received" | "closed">>;
  inbox(): Promise<CloudResult<{ sessionId: string; createdAt: string }[]>>;
  inboxImage(sessionId: string): Promise<CloudResult<Uint8Array>>;
  ack(sessionId: string): Promise<CloudResult<null>>;
}

export class HttpCloudClient implements CloudClient, CloudInboxClient {
  constructor(
    private readonly baseUrl: URL,
    private readonly secret: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(
    path: string,
    init: { body: BodyInit; headers: Record<string, string> },
    parse: (json: unknown) => T,
    /** Delete answers 409 when it lost a race (try again); put/reissue 409 is final. */
    retryConflict = false,
  ): Promise<CloudResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(new URL(path, this.baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${this.secret}`, ...init.headers },
        body: init.body,
        signal: controller.signal,
        cache: "no-store",
      });
      if (res.ok) return { ok: true, value: parse(await res.json().catch(() => null)) };
      // 401 too: a wrong secret is a configuration problem staff can fix, so keep the work.
      const retry =
        res.status === 401 ||
        res.status === 429 ||
        res.status >= 500 ||
        (retryConflict && res.status === 409);
      return { ok: false, retry, gone: res.status === 410, message: `cloud ${res.status}` };
    } catch (err) {
      const message = err instanceof Error ? err.name || err.message : String(err);
      return { ok: false, retry: true, message: `cloud unreachable (${message})` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Like `call`, for answers that are image bytes rather than JSON. */
  private async callBytes(path: string, body: unknown): Promise<CloudResult<Uint8Array>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(new URL(path, this.baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
      if (res.ok) return { ok: true, value: new Uint8Array(await res.arrayBuffer()) };
      const retry = res.status === 401 || res.status === 429 || res.status >= 500;
      return { ok: false, retry, gone: res.status === 410, message: `cloud ${res.status}` };
    } catch (err) {
      const message = err instanceof Error ? err.name || err.message : String(err);
      return { ok: false, retry: true, message: `cloud unreachable (${message})` };
    } finally {
      clearTimeout(timer);
    }
  }

  private json<T>(path: string, body: unknown, parse: (json: unknown) => T) {
    return this.call(
      path,
      { body: JSON.stringify(body), headers: { "content-type": "application/json" } },
      parse,
    );
  }

  createUploadSession() {
    return this.json("/api/hub/uploads/session", {}, (json) => {
      const j = (json ?? {}) as Partial<CloudUploadSession>;
      if (
        typeof j.sessionId !== "string" ||
        typeof j.url !== "string" ||
        typeof j.expiresAt !== "string"
      )
        throw new Error("unexpected cloud response");
      return { sessionId: j.sessionId, url: j.url, expiresAt: j.expiresAt };
    });
  }

  uploadStatus(sessionId: string) {
    return this.json("/api/hub/uploads/status", { sessionId }, (json) => {
      const status = (json as { status?: unknown } | null)?.status;
      if (status !== "waiting" && status !== "received" && status !== "closed")
        throw new Error("unexpected cloud response");
      return status;
    });
  }

  inbox() {
    return this.json("/api/hub/uploads/list", {}, (json) => {
      const items = (json as { items?: unknown } | null)?.items;
      if (!Array.isArray(items)) throw new Error("unexpected cloud response");
      return items
        .filter(
          (i): i is { sessionId: string; createdAt: string } =>
            typeof i?.sessionId === "string" && typeof i?.createdAt === "string",
        )
        .map(({ sessionId, createdAt }) => ({ sessionId, createdAt }));
    });
  }

  inboxImage(sessionId: string) {
    return this.callBytes("/api/hub/uploads/image", { sessionId });
  }

  ack(sessionId: string) {
    return this.call(
      "/api/hub/uploads/ack",
      { body: JSON.stringify({ sessionId }), headers: { "content-type": "application/json" } },
      () => null,
      true,
    );
  }

  put(photo: { sessionId: string; frameId: string; mime: PhotoMime; data: Uint8Array }) {
    return this.call(
      "/api/hub/photos",
      {
        body: photo.data as unknown as BodyInit,
        headers: {
          "content-type": photo.mime,
          "x-session-id": photo.sessionId,
          "x-frame-id": photo.frameId,
        },
      },
      toLink,
    );
  }

  reissue(sessionId: string) {
    return this.call(
      "/api/hub/photos/reissue",
      { body: JSON.stringify({ sessionId }), headers: { "content-type": "application/json" } },
      toLink,
    );
  }

  remove(sessionId: string) {
    return this.call(
      "/api/hub/photos/delete",
      { body: JSON.stringify({ sessionId }), headers: { "content-type": "application/json" } },
      () => null,
      true,
    );
  }
}

function toLink(json: unknown): CloudLink {
  const j = (json ?? {}) as Partial<CloudLink>;
  if (typeof j.token !== "string" || typeof j.url !== "string" || typeof j.expiresAt !== "string")
    throw new Error("unexpected cloud response");
  return { token: j.token, url: j.url, expiresAt: j.expiresAt };
}
