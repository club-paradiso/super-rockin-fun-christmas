import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  chooseKioskFrontend,
  KIOSK_FRONTEND_COOKIE,
  KIOSK_PROBE_COOKIE,
  KIOSK_PROBE_PARAM,
} from "@/lib/kiosk/frontend";

/**
 * Selects the kiosk renderer at the public entry and refreshes the Supabase session on staff
 * pages. The booth renderers and staff routes verify their own server-side authorization.
 */
export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.replace(/\/$/, "") === "/kiosk") {
    const frontend = chooseKioskFrontend({
      preference: request.cookies.get(KIOSK_FRONTEND_COOKIE)?.value,
      userAgent: request.headers.get("user-agent") ?? "",
      probe:
        request.nextUrl.searchParams.get(KIOSK_PROBE_PARAM) ??
        request.cookies.get(KIOSK_PROBE_COOKIE)?.value,
    });
    const destination = request.nextUrl.clone();
    destination.pathname = `/kiosk/${frontend}`;
    const response =
      frontend === "modern" ? NextResponse.next() : NextResponse.rewrite(destination);
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.append("Vary", "User-Agent, Cookie");
    return response;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  const hasSession = request.cookies.getAll().some((c) => c.name.startsWith("sb-"));
  if (!url || !key || !hasSession) return NextResponse.next();

  const secure = request.nextUrl.protocol === "https:";
  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookieOptions: { httpOnly: true, sameSite: "lax", secure, path: "/" },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const c of list) request.cookies.set(c.name, c.value);
        response = NextResponse.next({ request });
        for (const c of list) {
          response.cookies.set(c.name, c.value, {
            ...c.options,
            httpOnly: true,
            sameSite: "lax",
            secure,
            path: "/",
          });
        }
      },
    },
    auth: { detectSessionInUrl: false },
  });
  await supabase.auth.getUser();
  return response;
}

export const config = { matcher: ["/kiosk", "/admin/:path*"] };
