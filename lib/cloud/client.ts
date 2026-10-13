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

export class HttpCloudClient implements CloudClient {
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
