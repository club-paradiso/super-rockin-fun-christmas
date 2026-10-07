import QRCode from "qrcode";

/** Public download page for a token. `origin` has no trailing slash requirements. */
export function buildDownloadUrl(origin: string, token: string): string {
  return new URL(`/p/${encodeURIComponent(token)}`, origin).toString();
}

/** Base for QR links: the configured public origin, else the kiosk's own origin. */
export function publicOrigin(configured: string | undefined, fallback: string): string {
  const value = configured?.trim();
  return value ? value : fallback;
}

/** Inline SVG markup for a QR code. Quiet zone included; scales crisply at any size. */
export function makeQrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
}
