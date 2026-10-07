import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refreshes the staff Supabase session for /admin pages (Server Components cannot write
 * cookies). Authorization is NOT decided here: every admin page and API re-checks the session
 * and the staff allowlist on the server.
 */
export async function proxy(request: NextRequest) {
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

export const config = { matcher: ["/admin/:path*"] };
