import { authenticateKioskRequest, readCookie } from "@/lib/kiosk-auth/server";
import {
  KIOSK_FRONTEND_COOKIE,
  KIOSK_PROBE_COOKIE,
  parseFrontend,
  type KioskPreference,
} from "@/lib/kiosk/frontend";
import { kioskHtml } from "@/lib/kiosk/frontend-html";
import { getServerConfig, secureCookies } from "@/lib/server/env";
import { route, seeOther } from "@/lib/server/http";
import { adminPasswordLimits } from "@/lib/server/rate-limit";
import { clientIp, isSameOrigin } from "@/lib/server/request";
import {
  applyCookies,
  authorizeStaffRequest,
  checkAdminPassword,
  type PendingCookie,
} from "@/lib/staff-auth/server";

export const dynamic = "force-dynamic";

const MODES = [
  { value: "auto", label: "자동 / Auto" },
  { value: "modern", label: "표준 / Modern" },
  { value: "legacy", label: "호환 / Legacy" },
] as const;

const ERRORS: Record<string, string> = {
  "400": "화면 모드를 선택해 주세요.",
  "401": "운영자 비밀번호가 맞지 않거나 운영자 로그인이 필요해요.",
  "429": "시도가 너무 많아요. 15분 뒤에 다시 시도해 주세요.",
};

function staffScreen(status: number, body: string): Response {
  return kioskHtml(
    `<main class="kiosk-notice"><h1>키오스크 화면 설정</h1>${body}
<p><a href="/kiosk">키오스크로 돌아가기</a></p></main>`,
    "",
    status,
  );
}

export const GET = route("kiosk_frontend", async (request: Request) => {
  const config = getServerConfig();
  if (!(await authenticateKioskRequest(request)).ok) {
    return staffScreen(401, '<p>이 기기를 먼저 <a href="/kiosk/enroll">등록</a>해 주세요.</p>');
  }

  // Parse only our fixed preference values. These cookies carry no authority.
  const current = parseFrontend(readCookie(request, KIOSK_FRONTEND_COOKIE)) ?? "auto";
  const error = ERRORS[new URL(request.url).searchParams.get("error") ?? ""];
  const notice = typeof error === "string" ? `<p role="alert">${error}</p>` : "";
  const credentials = config.sharedAdmin
    ? '<label>운영자 비밀번호 <input name="password" type="password" autocomplete="off" maxlength="512"></label>'
    : '<p>이 브라우저에서 기존 운영자 계정에 로그인한 뒤 적용해 주세요.</p><a href="/admin">운영자 로그인</a>';
  return staffScreen(
    200,
    `${notice}<p>이 브라우저에서 사용할 화면을 선택해 주세요. 변경하기 전에 손님의 촬영을 마쳐 주세요.</p>
<form method="post" action="/kiosk/frontend">
<label>화면 모드
<select name="mode">${MODES.map(({ value, label }) => `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`).join("")}</select>
</label>
${credentials}
<button type="submit">적용하고 키오스크 열기</button>
</form>`,
  );
});

export const POST = route("kiosk_frontend_change", async (request: Request) => {
  const config = getServerConfig();
  if (!isSameOrigin(request, [config.publicBaseUrl])) {
    return staffScreen(403, "<p>다른 사이트에서는 화면 모드를 변경할 수 없어요.</p>");
  }
  if (!(await authenticateKioskRequest(request)).ok) {
    return staffScreen(401, '<p>이 기기를 먼저 <a href="/kiosk/enroll">등록</a>해 주세요.</p>');
  }

  const form = await request.formData().catch(() => null);
  const input = form?.get("mode");
  const mode: KioskPreference | undefined =
    input === "auto" ? input : parseFrontend(typeof input === "string" ? input : null);
  const fail = (status: number) => seeOther(`/kiosk/frontend?error=${status}`);
  if (!mode) return fail(400);

  let pending: PendingCookie[] = [];
  const password = form?.get("password");
  if (typeof password === "string" && password && config.sharedAdmin) {
    const ip = clientIp(request);
    const limits = adminPasswordLimits();
    if (!limits.perIp.take(ip) || limits.failuresPerIp.isLimited(ip)) return fail(429);
    if (password.length > 512 || !checkAdminPassword(password)) {
      limits.failuresPerIp.take(ip);
      return fail(401);
    }
  } else {
    const staff = await authorizeStaffRequest(request);
    if (!staff.auth.ok) return fail(401);
    pending = staff.pending;
  }

  const secure = secureCookies(config, request) ? "; Secure" : "";
  const preference = mode === "auto" ? "" : mode;
  const response = seeOther("/kiosk");
  response.headers.append(
    "set-cookie",
    `${KIOSK_FRONTEND_COOKIE}=${preference}; Path=/kiosk; HttpOnly; SameSite=Lax; Max-Age=${preference ? 31_536_000 : 0}${secure}`,
  );
  // Switching back to Auto must rerun capability detection, including after an OS update.
  response.headers.append(
    "set-cookie",
    `${KIOSK_PROBE_COOKIE}=; Path=/kiosk; SameSite=Lax; Max-Age=0${secure}`,
  );
  return applyCookies(response, pending);
});
