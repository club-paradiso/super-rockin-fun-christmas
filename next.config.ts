import type { NextConfig } from "next";
import { parseWallHosts, wallHostRedirects, wallHostRewrites } from "./lib/wall/host";

/** Dedicated media-wall address(es) (D68), read at build time. Unset = no change at all. */
const wallHosts = parseWallHosts(process.env.WALL_HOSTS);

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  // "same-origin", not "no-referrer": with no-referrer, Chrome sends `Origin: null` on form
  // POSTs, which defeats the Origin-based CSRF check. Guest photo pages set no-referrer themselves.
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // Camera only for this origin (the kiosk); nothing else is used.
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(), geolocation=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async rewrites() {
    return { beforeFiles: wallHostRewrites(wallHosts), afterFiles: [], fallback: [] };
  },
  async redirects() {
    return wallHostRedirects(wallHosts, process.env.PUBLIC_BASE_URL?.trim() || null);
  },
};

export default nextConfig;
