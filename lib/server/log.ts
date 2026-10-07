/**
 * Minimal structured logs (one JSON line per event) for Vercel / container log viewers.
 * Never pass raw download tokens, image bytes, secrets or personal data here.
 */
type Fields = Record<string, string | number | boolean | null | undefined>;

const FORBIDDEN = /token(?!_hash)|secret|password|key$/i;

export function logEvent(
  event: string,
  fields: Fields = {},
  level: "info" | "warn" | "error" = "info",
) {
  const safe: Fields = {};
  for (const [k, v] of Object.entries(fields)) safe[k] = FORBIDDEN.test(k) ? "[redacted]" : v;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
