import { ProviderError } from "../types";

/** Base64 without Buffer-specific types leaking into the adapters. */
export const toBase64 = (data: Uint8Array) => Buffer.from(data).toString("base64");

/** Retry-After as milliseconds: delta seconds or an HTTP date. Null when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * One POST with a JSON body. Maps everything that can go wrong before a readable 2xx answer to a
 * ProviderError kind, the same way for every adapter:
 *
 *   aborted (our timeout)        → timeout        (retry later)
 *   fetch threw                  → network        (retry later)
 *   408                          → timeout
 *   429                          → rate_limited   (with Retry-After when given)
 *   5xx                          → unavailable
 *   401, 403                     → auth           (do not retry: the key or the account is wrong)
 *   any other non-2xx            → bad_response   (do not retry: e.g. a retired model, a bad request)
 *   2xx that is not JSON         → bad_response
 *
 * The error message carries the status only. The provider's error body is not copied into it: it
 * is unbounded text we did not write, and it must not end up in logs or in the database.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<{ json: unknown; headers: Headers }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
      // A provider must never redirect our request (and the picture in it) somewhere else.
      redirect: "error",
    });
  } catch (err) {
    if (signal.aborted) throw new ProviderError("timeout", "request timed out");
    throw new ProviderError("network", err instanceof Error ? err.name : "fetch failed");
  }
  if (!response.ok) {
    const s = response.status;
    // Let the connection go; the body is deliberately not read.
    await response.body?.cancel().catch(() => undefined);
    if (s === 429)
      throw new ProviderError(
        "rate_limited",
        "HTTP 429",
        retryAfterMs(response.headers.get("retry-after")),
      );
    if (s === 408) throw new ProviderError("timeout", "HTTP 408");
    if (s === 401 || s === 403) throw new ProviderError("auth", `HTTP ${s}`);
    if (s >= 500) throw new ProviderError("unavailable", `HTTP ${s}`);
    throw new ProviderError("bad_response", `HTTP ${s}`);
  }
  try {
    return { json: (await response.json()) as unknown, headers: response.headers };
  } catch {
    if (signal.aborted) throw new ProviderError("timeout", "request timed out");
    throw new ProviderError("bad_response", "answer was not JSON");
  }
}
