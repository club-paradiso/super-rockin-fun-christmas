/**
 * How a guest's phone can save the picture on /p/[token] (the download page only; the booth
 * never reads this). Pure: the user agent in, a decision out.
 *
 * Why it matters: on iPhone the share sheet has "이미지 저장" (to Photos), so share is the best
 * save. Android's share sheet has no "save to gallery" entry (Galaxy guests were lost in it), but
 * a plain download lands in the gallery's Download album. In-app browsers (KakaoTalk, NAVER,
 * Instagram …) often drop downloads entirely, so the page offers to reopen in the real browser.
 */

export type PhoneOs = "ios" | "android" | "other";

export type InAppBrowser =
  "kakaotalk" | "naver" | "instagram" | "facebook" | "line" | "daum" | "band" | "other";

export type SaveEnv = {
  os: PhoneOs;
  /** Samsung Internet (Galaxy's own browser). */
  samsung: boolean;
  /** Null in a real browser. */
  inApp: InAppBrowser | null;
};

export const DEFAULT_SAVE_ENV: SaveEnv = { os: "other", samsung: false, inApp: null };

const IN_APP: ReadonlyArray<[InAppBrowser, RegExp]> = [
  ["kakaotalk", /KAKAOTALK/i],
  ["naver", /NAVER\(inapp|\bNAVER\//i],
  ["instagram", /Instagram/i],
  ["facebook", /FBAN|FBAV|FB_IAB/i],
  ["line", /\bLine\//i],
  ["daum", /DaumApps/i],
  ["band", /\bBAND\//i],
];

export function detectSaveEnv(userAgent: string, maxTouchPoints = 0): SaveEnv {
  const ua = userAgent || "";
  const android = /Android/i.test(ua);
  // iPadOS 13+ says "Macintosh"; touch points tell it apart from a Mac.
  const ios =
    !android && (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1));
  const os: PhoneOs = android ? "android" : ios ? "ios" : "other";
  let inApp: InAppBrowser | null = null;
  for (const [name, pattern] of IN_APP) {
    if (pattern.test(ua)) {
      inApp = name;
      break;
    }
  }
  // A generic Android WebView ("; wv)") that is none of the above.
  if (!inApp && android && /;\s*wv\)/i.test(ua)) inApp = "other";
  return { os, samsung: /SamsungBrowser/i.test(ua), inApp };
}

/**
 * The main "save" button: the share sheet only where it has a save entry (iPhone, and desktop
 * browsers that offer it), a direct download on Android.
 */
export function prefersShareToSave(env: SaveEnv): boolean {
  return env.os !== "android";
}

/**
 * A link that opens this page in the phone's real browser, or null when there is no reliable
 * one (then the page explains the menu instead). Not verified on every app version.
 */
export function externalBrowserUrl(env: SaveEnv, pageUrl: string): string | null {
  if (!env.inApp) return null;
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (env.inApp === "kakaotalk") {
    return `kakaotalk://web/openExternal?url=${encodeURIComponent(url.toString())}`;
  }
  if (env.inApp === "line") {
    url.searchParams.set("openExternalBrowser", "1");
    return url.toString();
  }
  if (env.os === "android") {
    const scheme = url.protocol.slice(0, -1);
    return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=${scheme};action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end`;
  }
  return null;
}

/** Where Android puts the file, in the guest's words. */
export const ANDROID_SAVED_HINT =
  "저장이 끝나면 갤러리 앱의 ‘Download(다운로드)’ 앨범이나 알림창에서 볼 수 있어요.";

export function longPressHint(env: SaveEnv): string {
  if (env.os === "android")
    return env.samsung
      ? "사진을 길게 눌러 ‘이미지 저장’을 골라도 돼요."
      : "사진을 길게 눌러 ‘이미지 다운로드’를 골라도 돼요.";
  return "사진을 길게 눌러 ‘사진 앱에 저장’도 할 수 있어요.";
}

export function inAppMenuHint(env: SaveEnv): string {
  return env.os === "ios"
    ? "오른쪽 아래(또는 위) 메뉴에서 ‘Safari로 열기’를 눌러 주세요."
    : "오른쪽 위 ⋮ 메뉴에서 ‘다른 브라우저로 열기’를 눌러 주세요.";
}
