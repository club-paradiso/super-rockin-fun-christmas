import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FOLLOW THE LIGHTS",
  description: "Christmas Village 2026 — 네컷 포토부스 × 참여형 미디어월",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b1122",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
