import { cameraLabEnabled } from "@/lib/camera-engine/lab-gate";
import { NO_STORE } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * The camera engine check page: the tablet's own camera with and without the correction, what
 * its sensors say, a test shot with its timing, and a self-test of the WebGL renderer against
 * the reference arithmetic. A standalone page (no Next scripts) so that Safari 15 on the iPad
 * mini 4 can open it: this is where docs/CAMERA_ENGINE.md's device checklist is worked through.
 *
 * A development and acceptance tool, not a guest page (lib/camera-engine/lab-gate.ts says where
 * it is served). It stores nothing and sends nothing anywhere.
 */
export function GET(): Response {
  if (!cameraLabEnabled()) return new Response("Not found", { status: 404, headers: NO_STORE });
  return new Response(
    `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>STUDIO SHALOM · 카메라 자동 보정 점검</title>
<link rel="stylesheet" href="/camera-lab-assets/entry.css">
<script type="module" src="/camera-lab-assets/entry.js"></script>
</head>
<body><div id="camera-lab"><p class="lab-boot">점검 페이지를 여는 중…</p><noscript>JavaScript를 켜 주세요.</noscript></div></body>
</html>`,
    { headers: { ...NO_STORE, "content-type": "text/html; charset=utf-8" } },
  );
}
