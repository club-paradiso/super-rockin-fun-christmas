import { authenticateKioskRequest } from "@/lib/kiosk-auth/server";
import { kioskBootstrap } from "@/lib/kiosk/bootstrap";
import { escapeHtml, kioskHtml } from "@/lib/kiosk/frontend-html";
import { ConfigError, getServerConfig } from "@/lib/server/env";
import { route } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";

export const dynamic = "force-dynamic";

export const GET = route("kiosk_legacy", async (request: Request) => {
  try {
    getServerConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    logEvent(
      "config_invalid",
      { route: "kiosk_legacy", problems: error.problems.join(" | ") },
      "error",
    );
    return kioskHtml(
      '<main class="kiosk-notice" data-testid="kiosk-config-error"><h1>서버 설정 오류</h1><p>운영팀에 문의해 주세요.</p></main>',
      "",
      503,
    );
  }

  const auth = await authenticateKioskRequest(request);
  if (!auth.ok) {
    return kioskHtml(`<main class="kiosk-notice" data-testid="kiosk-not-enrolled">
<h1>이 기기는 아직 키오스크로 등록되지 않았어요</h1>
<p>운영자가 등록해야 촬영을 시작할 수 있어요.</p>
<a href="/kiosk/enroll">기기 등록하기</a>
</main>`);
  }

  const params = new URL(request.url).searchParams;
  const cameras = params.getAll("camera");
  const props = await kioskBootstrap(cameras.length === 1 ? cameras[0] : undefined);
  return kioskHtml(
    `<div id="legacy-kiosk" data-config="${escapeHtml(JSON.stringify(props))}">
<main class="kiosk-notice">
<h1>STUDIO SHALOM</h1>
<p>호환 모드에서 키오스크를 여는 중이에요.</p>
<p><a href="/kiosk/frontend">운영자 화면 설정</a></p>
<noscript><p>촬영하려면 브라우저에서 JavaScript를 켜 주세요.</p></noscript>
</main>
</div>`,
    '<link rel="stylesheet" href="/kiosk-legacy-assets/entry.css"><script type="module" src="/kiosk-legacy-assets/entry.js"></script>',
  );
});
