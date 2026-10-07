import { timingSafeEqual, createHash } from "node:crypto";

/**
 * Best-effort client IP for rate limiting. Behind Vercel the first x-forwarded-for entry is set by
 * the platform; on a bare server it is client-controlled, so never use it for authorization.
 */
export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests: browsers always send Origin on
 * cross-site POSTs, so a present Origin must match this server. (SameSite=Lax on the kiosk cookie
 * is the first line; this is the second.)
 */
export function isSameOrigin(request: Request, allowed: (URL | null)[] = []): boolean {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (origin === "null") {
    // Opaque origin (e.g. a form POST under a no-referrer policy). Trust only the browser's own
    // fetch-metadata header, which page scripts cannot set.
    return site === "same-origin";
  }
  if (!origin) {
    // Non-browser clients and some same-origin navigations omit Origin. Fetch metadata, when
    // present, still lets us refuse an explicit cross-site request.
    return site === null || site === "same-origin" || site === "none";
  }
  const self = new URL(request.url).origin;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto =
    request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  const candidates = new Set([self, ...(host ? [`${proto}://${host}`] : [])]);
  for (const u of allowed) if (u) candidates.add(u.origin);
  return candidates.has(origin);
}

export class BodyTooLargeError extends Error {}

/** Read a request body but stop as soon as it exceeds `max` bytes (don't trust content-length). */
export async function readBodyLimited(request: Request, max: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > max) throw new BodyTooLargeError();
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Constant-time string comparison (hash first so lengths don't leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function bearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  const m = h?.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Magic-byte check. JPEG must also end with the EOI marker, which catches truncated uploads. */
export function hasImageSignature(data: Uint8Array, mime: string): boolean {
  if (mime === "image/jpeg") {
    const n = data.length;
    return (
      n > 4 && JPEG.every((b, i) => data[i] === b) && data[n - 2] === 0xff && data[n - 1] === 0xd9
    );
  }
  if (mime === "image/png") return data.length > 8 && PNG.every((b, i) => data[i] === b);
  return false;
}
