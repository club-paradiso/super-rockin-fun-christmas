import { describe, expect, it } from "vitest";
import { chooseKioskFrontend, frontendFromUserAgent } from "@/lib/kiosk/frontend";

const desktopSafari =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/15.6 Safari/605.1.15";

describe("adaptive kiosk routing", () => {
  it.each([
    ["Mozilla/5.0 (iPad; CPU OS 15_8_8 like Mac OS X) Safari/604.1", "legacy"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) CriOS/111.0", "legacy"],
    ["Mozilla/5.0 (iPad; CPU OS 16_3 like Mac OS X) Safari/604.1", "legacy"],
    ["Mozilla/5.0 (iPad; CPU OS 16_4 like Mac OS X) Safari/604.1", "modern"],
    ["Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) Safari/605.1", "modern"],
    ["Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/141.0 Safari/537.36", "modern"],
    ["Mozilla/5.0 (Android 15) Chrome/141.0 Mobile Safari/537.36", "modern"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:141.0) Gecko/20100101 Firefox/141.0", "modern"],
    [desktopSafari, "probe"],
    [desktopSafari.replace("15.6", "18.2"), "probe"],
    ["Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15", "probe"],
    ["", "probe"],
  ])("routes %s to %s", (ua, expected) => {
    expect(frontendFromUserAgent(ua)).toBe(expected);
  });

  it("honors an operator preference before a browser probe or User-Agent", () => {
    expect(
      chooseKioskFrontend({ userAgent: desktopSafari, probe: "modern", preference: "legacy" }),
    ).toBe("legacy");
    expect(chooseKioskFrontend({ userAgent: "iPad; CPU OS 15_8", preference: "modern" })).toBe(
      "modern",
    );
  });

  it("accepts probe results only for ambiguous devices and ignores unknown preferences", () => {
    expect(
      chooseKioskFrontend({ userAgent: desktopSafari, probe: "legacy", preference: "auto" }),
    ).toBe("legacy");
    expect(chooseKioskFrontend({ userAgent: desktopSafari, probe: "bad", preference: "bad" })).toBe(
      "probe",
    );
    expect(chooseKioskFrontend({ userAgent: "iPad; CPU OS 15_8", probe: "modern" })).toBe("legacy");
  });
});
