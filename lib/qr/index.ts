import QRCode from "qrcode";

/**
 * Inline SVG markup for a QR code. The URL itself always comes from the server (built from
 * PUBLIC_BASE_URL), never from the kiosk's own location, so a kiosk on a LAN address cannot
 * print an unreachable link.
 */
export function makeQrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
}
