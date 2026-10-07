import "server-only";
import type { ServerConfig } from "./env";

/**
 * Origin used in guest QR codes. Always PUBLIC_BASE_URL when set. Outside strict (production)
 * mode, falls back to the request's own origin so local development works without config.
 */
export function publicOrigin(config: ServerConfig, request: Request): string {
  if (config.publicBaseUrl) return config.publicBaseUrl.origin;
  if (config.strict) throw new Error("PUBLIC_BASE_URL missing in strict mode");
  return new URL(request.url).origin;
}

export function guestUrl(origin: string, token: string): string {
  return new URL(`/p/${encodeURIComponent(token)}`, origin).toString();
}
