export const KIOSK_FRONTEND_COOKIE = "ftl_kiosk_frontend";
export const KIOSK_PROBE_COOKIE = "ftl_kiosk_probe";
export const KIOSK_PROBE_PARAM = "kioskDetected";

export type KioskFrontend = "modern" | "legacy";
export type KioskPreference = "auto" | KioskFrontend;

export function parseFrontend(value: string | null | undefined): KioskFrontend | undefined {
  return value === "modern" || value === "legacy" ? value : undefined;
}

function supportsNextSafari(major: string, minor = "0"): boolean {
  return Number(major) > 16 || (Number(major) === 16 && Number(minor) >= 4);
}

/** iOS browser brands share WebKit here. Macintosh Safari can be an iPad in desktop mode. */
export function frontendFromUserAgent(userAgent: string): KioskFrontend | "probe" {
  if (/\b(iPad|iPhone|iPod)\b/.test(userAgent)) {
    const ios = userAgent.match(/\b(?:CPU (?:iPhone )?OS|iPhone OS) (\d+)(?:[_.](\d+))?/);
    return ios ? (supportsNextSafari(ios[1]!, ios[2]) ? "modern" : "legacy") : "probe";
  }
  if (
    /Macintosh.*AppleWebKit/.test(userAgent) &&
    !/\b(?:Chrome|Chromium|Edg|OPR)\//.test(userAgent)
  )
    return "probe";
  const safari = userAgent.match(/Version\/(\d+)(?:\.(\d+))?.*Safari\//);
  if (safari && !supportsNextSafari(safari[1]!, safari[2])) return "legacy";
  return userAgent ? "modern" : "probe";
}

export function chooseKioskFrontend({
  preference,
  userAgent,
  probe,
}: {
  preference?: string;
  userAgent: string;
  probe?: string | null;
}): KioskFrontend | "probe" {
  const device = frontendFromUserAgent(userAgent);
  return (
    parseFrontend(preference) ?? (device === "probe" ? (parseFrontend(probe) ?? device) : device)
  );
}
