import { NO_STORE } from "@/lib/server/http";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Response body for booth pages that must load even without Next's browser runtime. */
export function kioskHtml(body: string, head = "", status = 200): Response {
  return new Response(
    `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ddbda1">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="STUDIO SHALOM">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="/kiosk.webmanifest">
<meta name="robots" content="noindex, nofollow">
<title>STUDIO SHALOM · Photo Booth</title>
<link rel="stylesheet" href="/kiosk-shell.css">
${head}
</head>
<body>${body}</body>
</html>`,
    {
      status,
      headers: { ...NO_STORE, "content-type": "text/html; charset=utf-8" },
    },
  );
}
