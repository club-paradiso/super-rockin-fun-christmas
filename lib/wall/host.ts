/**
 * Dedicated media-wall address (D68). The wall is the same Next.js app and the same /wall
 * renderer; a second hostname (e.g. follow-the-lights-wall.vercel.app) is pointed at the same
 * deployment, and these rules make that hostname a wall-only site:
 *
 *   wall host  /               → renders /wall (rewrite: the address bar stays clean)
 *   wall host  /admin, /kiosk, /m/…, /p/…  → sent to the booth address (nothing staff- or
 *              guest-facing is served under the wall's name)
 *   everything the wall itself needs (/wall, /api/wall/*, /api/kiosk/heartbeat, /kiosk/enroll,
 *   /api/kiosk/enroll, static files) works unchanged.
 *
 * Kiosk cookies are host-only, so a display enrolled on the wall host has its own session and
 * cannot act as a booth on the booth host (and the other way round). Pure: next.config.ts calls it
 * at build time with WALL_HOSTS and PUBLIC_BASE_URL.
 */

export interface HostRule {
  source: string;
  has: { type: "host"; value: string }[];
  destination: string;
}

export interface RedirectRule extends HostRule {
  permanent: false;
}

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** "a.example.org, b.example.org" → valid lower-case hostnames (anything else is ignored). */
export function parseWallHosts(raw: string | undefined | null): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter((h) => HOSTNAME.test(h)),
    ),
  ];
}

/** Next.js `has.value` is a regular expression: match the whole hostname, literally. */
const exactHost = (host: string) => `^${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;

export function wallHostRewrites(hosts: string[]): HostRule[] {
  return hosts.map((host) => ({
    source: "/",
    has: [{ type: "host", value: exactHost(host) }],
    destination: "/wall",
  }));
}

/** Booth-only paths on the wall host go to the booth address (when one is configured). */
export function wallHostRedirects(hosts: string[], boothOrigin: string | null): RedirectRule[] {
  if (!boothOrigin) return [];
  let boothHost: string;
  try {
    boothHost = new URL(boothOrigin).hostname;
  } catch {
    return []; // an invalid PUBLIC_BASE_URL is reported by lib/server/env.ts, not by the build
  }
  const origin = boothOrigin.replace(/\/+$/, "");
  const paths = [
    { source: "/admin", destination: `${origin}/admin` },
    { source: "/admin/:path*", destination: `${origin}/admin/:path*` },
    { source: "/kiosk", destination: `${origin}/kiosk` },
    { source: "/m/:path*", destination: `${origin}/m/:path*` },
    { source: "/p/:path*", destination: `${origin}/p/:path*` },
  ];
  return hosts.flatMap((host) =>
    paths
      // Never redirect a host to itself.
      .filter(() => boothHost !== host)
      .map((p) => ({
        ...p,
        has: [{ type: "host" as const, value: exactHost(host) }],
        permanent: false as const,
      })),
  );
}
