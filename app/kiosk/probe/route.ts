import { KIOSK_PROBE_COOKIE, KIOSK_PROBE_PARAM } from "@/lib/kiosk/frontend";
import { escapeHtml, kioskHtml } from "@/lib/kiosk/frontend-html";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const destination = new URLSearchParams(new URL(request.url).search);
  destination.set(KIOSK_PROBE_PARAM, "legacy");
  return kioskHtml(
    `<main class="kiosk-notice" data-testid="kiosk-probe" data-probe-cookie="${KIOSK_PROBE_COOKIE}" data-probe-param="${KIOSK_PROBE_PARAM}">
<h1>STUDIO SHALOM</h1>
<p>키오스크 화면을 준비하고 있어요.</p>
<p><a href="/kiosk?${escapeHtml(destination.toString())}">호환 모드로 열기</a></p>
<noscript><p>촬영하려면 브라우저에서 JavaScript를 켜 주세요.</p></noscript>
</main>`,
    '<script defer src="/kiosk-probe.js"></script>',
  );
}
