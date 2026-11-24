/**
 * Where the lab page (/retouch-lab) is served: in development, on Vercel preview deployments, and
 * wherever `RETOUCH_LAB=1` is set (a hub, to measure the real iPad). `RETOUCH_LAB=0` turns it off
 * everywhere. On a production deployment without the variable it is a 404.
 */
export function retouchLabEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.RETOUCH_LAB === "1") return true;
  if (env.RETOUCH_LAB === "0") return false;
  return env.NODE_ENV !== "production" || env.VERCEL_ENV === "preview";
}
