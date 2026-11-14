import { describe, expect, it } from "vitest";
import { FRAMES, RETIRED_FRAME_IDS } from "@/config/frames";
import {
  framedPhotoFrame,
  isMobileFrameId,
  isMobilePhoto,
  MOBILE_FRAME_ID,
  MOBILE_UPLOAD_CONFIG,
  mobileBoothFrame,
  mobileFrameId,
  mobileFramesFor,
  photoSource,
} from "@/config/mobile";
import { cycleOrder, limitPicked } from "@/lib/mobile/prepare";
import { matchesFrameShape } from "@/lib/mobile/image";

/** D93: a phone photo can be put in any booth frame; its stored id says which. */
describe("phone photos in booth frames (D93)", () => {
  it("no booth frame id could be mistaken for a phone photo", () => {
    for (const id of [...FRAMES.map((f) => f.id), ...RETIRED_FRAME_IDS]) {
      expect(id.startsWith(MOBILE_UPLOAD_CONFIG.frameIdPrefix), id).toBe(false);
      expect(id, id).not.toBe("photo");
      // Stored ids must pass the database check `^[a-z0-9-]{1,64}$`.
      expect(mobileFrameId(id)).toMatch(/^[a-z0-9-]{1,64}$/);
    }
  });

  it("every number of photos from 1 to the maximum has at least one frame", () => {
    for (let n = 1; n <= MOBILE_UPLOAD_CONFIG.maxPhotos; n++)
      expect(mobileFramesFor(n).length, `${n} photos`).toBeGreaterThan(0);
    expect(mobileFramesFor(MOBILE_UPLOAD_CONFIG.maxPhotos + 1)).toEqual([]);
  });

  it("plain and framed phone photos are both phone photos; booth photos are not", () => {
    expect(isMobilePhoto({ frameId: MOBILE_FRAME_ID })).toBe(true);
    expect(isMobilePhoto({ frameId: "phone-shalom-letter" })).toBe(true);
    expect(isMobilePhoto({ frameId: "shalom-letter" })).toBe(false);
    expect(photoSource({ frameId: "phone-shalom-grid" })).toBe("mobile");
  });

  it("only current booth frames are accepted, and the wall hangs each one in its frame", () => {
    expect(isMobileFrameId(MOBILE_FRAME_ID)).toBe(true);
    for (const f of FRAMES) {
      expect(isMobileFrameId(mobileFrameId(f.id))).toBe(true);
      expect(mobileBoothFrame(mobileFrameId(f.id))).toBe(f);
      expect(framedPhotoFrame(mobileFrameId(f.id))).toBe(f);
      expect(framedPhotoFrame(f.id)).toBe(f);
    }
    for (const bad of ["shalom-letter", "phone-six-lights", "phone-", "phone-nope", "photo"])
      expect(isMobileFrameId(bad), bad).toBe(false);
    expect(mobileBoothFrame(MOBILE_FRAME_ID)).toBeNull();
  });

  it("the composed picture fits the server's framed bound at the booth's saved size", () => {
    for (const f of FRAMES)
      expect(Math.max(f.outputWidth, f.outputHeight) * 2).toBeLessThanOrEqual(
        MOBILE_UPLOAD_CONFIG.framedLongEdge,
      );
  });

  it("shape check: the frame's own proportions within 1 %", () => {
    const letter = { outputWidth: 600, outputHeight: 1800 };
    expect(matchesFrameShape({ width: 1200, height: 3600 }, letter)).toBe(true);
    expect(matchesFrameShape({ width: 683, height: 2048 }, letter)).toBe(true);
    expect(matchesFrameShape({ width: 1200, height: 900 }, letter)).toBe(false);
  });

  it("picking: at most six kept in the picker's order; reordering moves the first to the end", () => {
    expect(limitPicked([1, 2, 3], 6)).toEqual({ kept: [1, 2, 3], dropped: 0 });
    expect(limitPicked([1, 2, 3, 4, 5, 6, 7, 8], 6)).toEqual({
      kept: [1, 2, 3, 4, 5, 6],
      dropped: 2,
    });
    expect(cycleOrder(["a", "b", "c"])).toEqual(["b", "c", "a"]);
    expect(cycleOrder(["a"])).toEqual(["a"]);
  });
});
