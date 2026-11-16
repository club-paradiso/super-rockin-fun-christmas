import type { RtcIceServer } from "./types";

export interface IceConfig {
  servers: RtcIceServer[];
  /** Set when REMOTE_CAMERA_ICE_SERVERS was present but unusable: the default is used instead. */
  problem: string | null;
}

/** Free public STUN. Same-Wi-Fi links connect with local candidates and need no server at all. */
export const DEFAULT_ICE_SERVERS: RtcIceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];

const URL_RE = /^(stun|stuns|turn|turns):[A-Za-z0-9.\-_[\]:]+(\?transport=(udp|tcp))?$/;

/**
 * REMOTE_CAMERA_ICE_SERVERS = JSON array of {urls, username?, credential?} (a TURN fallback for
 * networks that block direct links). A wrong value never breaks the booth: it is ignored with a
 * problem the admin page shows. The list only ever reaches a paired camera and an enrolled booth.
 */
export function parseIceServers(raw: string | undefined): IceConfig {
  if (!raw || !raw.trim()) return { servers: DEFAULT_ICE_SERVERS, problem: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 6)
      throw new Error("shape");
    const servers: RtcIceServer[] = parsed.map((entry) => {
      const e = entry as Record<string, unknown>;
      const urls = Array.isArray(e.urls) ? e.urls : [e.urls];
      if (
        !urls.length ||
        urls.length > 4 ||
        !urls.every((u) => typeof u === "string" && URL_RE.test(u))
      )
        throw new Error("urls");
      const needsAuth = (urls as string[]).some((u) => u.startsWith("turn"));
      if (needsAuth && (typeof e.username !== "string" || typeof e.credential !== "string"))
        throw new Error("credentials");
      return {
        urls: urls as string[],
        ...(typeof e.username === "string" ? { username: e.username } : {}),
        ...(typeof e.credential === "string" ? { credential: e.credential } : {}),
      };
    });
    return { servers, problem: null };
  } catch {
    return {
      servers: DEFAULT_ICE_SERVERS,
      problem:
        "REMOTE_CAMERA_ICE_SERVERS is not valid JSON of stun:/turn: servers; using the default STUN",
    };
  }
}
