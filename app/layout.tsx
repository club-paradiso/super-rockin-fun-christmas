import type { Metadata, Viewport } from "next";
// Bundled fonts (all OFL), so the hub works offline. Noto Sans KR: UI and frame text. Noto Sans SC:
// the Chinese booth screens (D89; its files load only when a Chinese glyph is drawn). Cormorant
// Garamond (STUDIO, SHALOM) and Nanum Myeongjo (평화의 벽): the on-screen lockup only.
import "@fontsource-variable/noto-sans-kr";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource/cormorant-garamond/latin-500.css";
import "@fontsource/cormorant-garamond/latin-600.css";
import "@fontsource/nanum-myeongjo/400.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "STUDIO SHALOM",
  description: "Christmas Village 2026 — 네컷 포토부스 × 참여형 미디어월",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ddbda1",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
