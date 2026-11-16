/**
 * iPad mini 4 ends at iPadOS 15. iOS WebKit 15 does not have all of the CSS/JS
 * features or memory headroom expected by the standard Next 16 kiosk.
 *
 * This does NOT claim official Next.js support for Safari 15. It supplies a
 * deliberately smaller render budget and avoids optional video encoding.
 * Generic "Macintosh" desktop Safari must not be mistaken for an iPad.
 */
export interface BrowserSignature {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}

export function isLegacyIOS15({ userAgent, platform, maxTouchPoints }: BrowserSignature): boolean {
  const explicitIOS15 = /\b(?:CPU (?:iPhone )?OS) 15[_.]/.test(userAgent);
  if (explicitIOS15 && /\b(iPad|iPhone|iPod)\b/.test(userAgent)) return true;
  // iPadOS 13+ can request the desktop site; it then advertises "Macintosh".
  // The touch count distinguishes it from an actual macOS Safari browser.
  return (
    /Macintosh/.test(userAgent) &&
    platform === "MacIntel" &&
    (maxTouchPoints ?? 0) > 1 &&
    /Version\/15\./.test(userAgent) &&
    /Safari\//.test(userAgent) &&
    !/(?:CriOS|FxiOS|EdgiOS)/.test(userAgent)
  );
}

export function legacyIOS15InBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return isLegacyIOS15({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  });
}

export const STANDARD_RENDER_BUDGET = {
  cameraWidth: 1920,
  cameraHeight: 1080,
  captureMaxWidth: 1600,
  outputScale: 2,
  thumbScale: 0.62,
  recordVideo: true,
} as const;

export const LEGACY_IOS15_RENDER_BUDGET = {
  // The mini 4 is an A8/2 GB iPad. Avoid a 1080p MediaRecorder and seven 1600px canvases
  // competing with the 1200x3600 compositor, thumbnails and WebKit's GPU caches.
  cameraWidth: 1280,
  cameraHeight: 720,
  captureMaxWidth: 960,
  outputScale: 1,
  thumbScale: 0.35,
  recordVideo: false,
} as const;

export function kioskRenderBudget(
  legacyIOS15: boolean,
): typeof STANDARD_RENDER_BUDGET | typeof LEGACY_IOS15_RENDER_BUDGET {
  return legacyIOS15 ? LEGACY_IOS15_RENDER_BUDGET : STANDARD_RENDER_BUDGET;
}
