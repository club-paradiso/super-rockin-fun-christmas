import { retouchLabEnabled } from "@/lib/retouch/lab-gate";
import { NO_STORE } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * The skin-retouch lab: sample photos at each level side by side, sliders, zoom, the mask, the
 * same photos in a frame, and the timings of the device that opened the page. A standalone page
 * (no Next scripts) so that Safari 15 on the iPad mini 4 can open it.
 *
 * A development and acceptance tool, not a guest page (lib/retouch/lab-gate.ts says where it is
 * served). It reads no guest data and sends nothing anywhere.
 */
export function GET(): Response {
  if (!retouchLabEnabled()) return new Response("Not found", { status: 404, headers: NO_STORE });
  return new Response(
    `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>STUDIO SHALOM · 피부 보정 비교</title>
<link rel="stylesheet" href="/retouch-lab-assets/entry.css">
<script type="module" src="/retouch-lab-assets/entry.js"></script>
</head>
<body><div id="retouch-lab"><p class="lab-boot">비교 페이지를 여는 중…</p><noscript>JavaScript를 켜 주세요.</noscript></div></body>
</html>`,
    { headers: { ...NO_STORE, "content-type": "text/html; charset=utf-8" } },
  );
}
