import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isLegacyIOS15,
  kioskRenderBudget,
  LEGACY_IOS15_RENDER_BUDGET,
  STANDARD_RENDER_BUDGET,
} from "@/lib/kiosk/legacy-ios";
import { newSessionId } from "@/lib/kiosk/session";
import { KIOSK_CONFIG } from "@/config/kiosk";
import { readFileSync } from "node:fs";
import path from "node:path";

const IPAD_15 =
  "Mozilla/5.0 (iPad; CPU OS 15_8_8 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/15.8 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/15.8 Safari/605.1.15";

describe("iPad mini 4 / Safari 15 detection", () => {
  it("detects legacy Safari 15 on normal iPad UA, including patch releases", () => {
    expect(isLegacyIOS15({ userAgent: IPAD_15 })).toBe(true);
    expect(
      isLegacyIOS15({
        userAgent: IPAD_15.replace("iPad; CPU OS", "iPhone; CPU iPhone OS"),
      }),
    ).toBe(true);
  });

  it("detects iPad desktop website UA using its touch signature", () => {
    expect(isLegacyIOS15({ userAgent: IPAD_DESKTOP, platform: "MacIntel", maxTouchPoints: 5 })).toBe(
      true,
    );
    expect(isLegacyIOS15({ userAgent: IPAD_DESKTOP, platform: "MacIntel", maxTouchPoints: 0 })).toBe(
      false,
    );
    expect(isLegacyIOS15({ userAgent: IPAD_DESKTOP, platform: "Win32", maxTouchPoints: 5 })).toBe(
      false,
    );
  });

  it("does not penalize modern iPads or non-Apple desktop browsers", () => {
    expect(isLegacyIOS15({ userAgent: IPAD_15.replace(/15_8_8/g, "16_7_2") })).toBe(false);
    expect(isLegacyIOS15({ userAgent: IPAD_DESKTOP.replace("Version/15.8", "Version/17.1"), platform: "MacIntel", maxTouchPoints: 5 })).toBe(false);
    expect(isLegacyIOS15({ userAgent: "Mozilla/5.0 Chrome/121.0", platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
  });

  it("keeps standard photo output on newer tablets but cuts memory cost on iOS 15", () => {
    expect(kioskRenderBudget(false)).toBe(STANDARD_RENDER_BUDGET);
    expect(kioskRenderBudget(true)).toBe(LEGACY_IOS15_RENDER_BUDGET);
    expect(STANDARD_RENDER_BUDGET.captureMaxWidth).toBe(KIOSK_CONFIG.captureMaxWidth);
    expect(STANDARD_RENDER_BUDGET.outputScale).toBe(KIOSK_CONFIG.outputScale);
    expect(STANDARD_RENDER_BUDGET.thumbScale).toBe(KIOSK_CONFIG.thumbScale);
    expect(LEGACY_IOS15_RENDER_BUDGET.cameraHeight).toBeLessThan(1080);
    expect(LEGACY_IOS15_RENDER_BUDGET.captureMaxWidth).toBeLessThan(1600);
    expect(LEGACY_IOS15_RENDER_BUDGET.outputScale).toBe(1);
    expect(LEGACY_IOS15_RENDER_BUDGET.recordVideo).toBe(false);
  });

  it("provides Safari 15 CSS feature fallbacks without removing normal styles", () => {
    const css = readFileSync(path.resolve(import.meta.dirname, "../../app/globals.css"), "utf8");
    expect(css).toContain("--sheet-faded: #f2e5d8");
    expect(css).toContain("@supports not (color: color-mix(in srgb, red, blue))");
    expect(css).toContain("@supports not (container-type: size)");
    expect(css).toContain('[data-legacy-ios15="true"]');
  });
});

describe("cryptographic UUID fallback on older WebKit", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses getRandomValues when randomUUID is unavailable and sets RFC4122 version + variant", () => {
    let count = 0;
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        count++;
        bytes.forEach((_, i) => { bytes[i] = (i + count) & 255; });
        return bytes;
      },
    });
    const a = newSessionId();
    const b = newSessionId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(b).not.toBe(a);
    expect(count).toBe(2);
  });

  it("never uses Math.random as a weak fallback without Web Crypto", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => newSessionId()).toThrow(/Secure random generator unavailable/);
  });
});
