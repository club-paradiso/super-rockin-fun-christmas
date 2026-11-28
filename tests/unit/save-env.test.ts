import { describe, expect, it } from "vitest";
import {
  detectSaveEnv,
  externalBrowserUrl,
  longPressHint,
  prefersShareToSave,
} from "@/lib/guest/save-env";

const GALAXY_SAMSUNG =
  "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36";
const GALAXY_CHROME =
  "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const GALAXY_KAKAO =
  "Mozilla/5.0 (Linux; Android 14; SM-S921N Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36;KAKAOTALK 2410530";
const GALAXY_NAVER =
  "Mozilla/5.0 (Linux; Android 14; SM-S921N Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36 NAVER(inapp; search; 2000; 12.8.5)";
const GALAXY_WEBVIEW =
  "Mozilla/5.0 (Linux; Android 14; SM-S921N Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const IPHONE_KAKAO = `${IPHONE.replace(" Safari/604.1", "")} KAKAOTALK 10.9.0`;
const IPAD_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const PAGE = "https://photo.example.org/p/abc_DEF-123";

describe("detectSaveEnv", () => {
  it("tells Galaxy browsers apart", () => {
    expect(detectSaveEnv(GALAXY_SAMSUNG)).toEqual({ os: "android", samsung: true, inApp: null });
    expect(detectSaveEnv(GALAXY_CHROME)).toEqual({ os: "android", samsung: false, inApp: null });
  });
  it("finds in-app browsers", () => {
    expect(detectSaveEnv(GALAXY_KAKAO).inApp).toBe("kakaotalk");
    expect(detectSaveEnv(GALAXY_NAVER).inApp).toBe("naver");
    expect(detectSaveEnv(GALAXY_WEBVIEW).inApp).toBe("other");
    expect(detectSaveEnv(IPHONE_KAKAO)).toMatchObject({ os: "ios", inApp: "kakaotalk" });
  });
  it("reads iPhone and iPadOS", () => {
    expect(detectSaveEnv(IPHONE)).toEqual({ os: "ios", samsung: false, inApp: null });
    expect(detectSaveEnv(IPAD_DESKTOP, 5).os).toBe("ios");
    expect(detectSaveEnv(IPAD_DESKTOP, 0).os).toBe("other");
    expect(detectSaveEnv("").os).toBe("other");
  });
});

describe("save method", () => {
  it("never opens the share sheet to save on Android", () => {
    expect(prefersShareToSave(detectSaveEnv(GALAXY_SAMSUNG))).toBe(false);
    expect(prefersShareToSave(detectSaveEnv(GALAXY_CHROME))).toBe(false);
    expect(prefersShareToSave(detectSaveEnv(IPHONE))).toBe(true);
  });
  it("uses the menu words of each browser", () => {
    expect(longPressHint(detectSaveEnv(GALAXY_SAMSUNG))).toContain("이미지 저장");
    expect(longPressHint(detectSaveEnv(GALAXY_CHROME))).toContain("이미지 다운로드");
    expect(longPressHint(detectSaveEnv(IPHONE))).toContain("사진 앱에 저장");
  });
});

describe("externalBrowserUrl", () => {
  it("is null in a real browser", () => {
    expect(externalBrowserUrl(detectSaveEnv(GALAXY_SAMSUNG), PAGE)).toBeNull();
  });
  it("uses KakaoTalk's own scheme on both phones", () => {
    const want = `kakaotalk://web/openExternal?url=${encodeURIComponent(PAGE)}`;
    expect(externalBrowserUrl(detectSaveEnv(GALAXY_KAKAO), PAGE)).toBe(want);
    expect(externalBrowserUrl(detectSaveEnv(IPHONE_KAKAO), PAGE)).toBe(want);
  });
  it("hands other Android apps to the browser with an intent", () => {
    expect(externalBrowserUrl(detectSaveEnv(GALAXY_NAVER), PAGE)).toBe(
      "intent://photo.example.org/p/abc_DEF-123#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end",
    );
  });
  it("has no link for other iPhone apps and refuses odd addresses", () => {
    const iosInsta = detectSaveEnv(`${IPHONE} Instagram 300.0`);
    expect(iosInsta.inApp).toBe("instagram");
    expect(externalBrowserUrl(iosInsta, PAGE)).toBeNull();
    expect(externalBrowserUrl(detectSaveEnv(GALAXY_KAKAO), "javascript:alert(1)")).toBeNull();
  });
});
