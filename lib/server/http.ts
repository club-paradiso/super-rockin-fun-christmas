import "server-only";
import { NextResponse } from "next/server";
import { ConfigError } from "./env";
import { logEvent } from "./log";

export const NO_STORE = { "cache-control": "no-store" };

export function jsonError(status: number, error: string, headers: Record<string, string> = {}) {
  return NextResponse.json({ error }, { status, headers: { ...NO_STORE, ...headers } });
}

/** Wrap a route handler: configuration problems become a loud 503, everything else a logged 500. */
export function route<A extends unknown[]>(
  name: string,
  handler: (...args: A) => Promise<Response>,
) {
  return async (...args: A): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof ConfigError) {
        logEvent("config_invalid", { route: name, problems: err.problems.join(" | ") }, "error");
        return jsonError(503, "server misconfigured");
      }
      logEvent(
        "route_error",
        { route: name, message: err instanceof Error ? err.message : String(err) },
        "error",
      );
      return jsonError(500, "internal error");
    }
  };
}

/**
 * 303 to a same-site path with a relative Location. Building an absolute URL from request.url
 * can switch host (localhost vs 127.0.0.1 vs the public name) and lose host-only cookies.
 */
export function seeOther(pathWithQuery: string, headers: Record<string, string> = {}) {
  return new Response(null, {
    status: 303,
    headers: { ...NO_STORE, location: pathWithQuery, ...headers },
  });
}
