/**
 * /looks: the look comparison sheet. Plain HTML that loads the stand-alone bundle built by
 * looks-sheet/vite.config.mts, so it opens on Safari 15 (the booth's iPad mini 4) as well.
 * It shows sample photos only; no guest photo, no session, nothing is sent anywhere.
 */
export const dynamic = "force-static";

const HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ddbda1">
<meta name="robots" content="noindex, nofollow">
<title>STUDIO SHALOM · 룩 비교 시트</title>
<link rel="stylesheet" href="/looks-sheet-assets/entry.css">
</head>
<body>
<div id="looks-sheet"><p class="sheet-boot">룩을 불러오는 중…</p></div>
<script type="module" src="/looks-sheet-assets/entry.js"></script>
</body>
</html>`;

export function GET(): Response {
  return new Response(HTML, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}
