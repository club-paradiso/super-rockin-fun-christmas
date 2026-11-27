import { describe, expect, it } from "vitest";
import { ALL_FRAMES, FRAMES, RETIRED_FRAME_IDS } from "@/config/frames";
import { OFFERED_V2_FRAMES, V2_FRAMES } from "@/config/frames/v2";
import {
  framedPhotoFrame,
  isMobileFrameId,
  isMobilePhoto,
  MOBILE_FRAME_ID,
  MOBILE_UPLOAD_CONFIG,
  mobileBoothFrame,
  mobileFrameId,
  MOBILE_FRAMES,
  mobileFramesFor,
  mobileOfferedFrame,
  photoSource,
} from "@/config/mobile";
import { limitPicked, settleSelection, toggleOrdered } from "@/lib/mobile/prepare";
import { matchesFrameShape } from "@/lib/mobile/image";

/** D93: a phone photo can be put in any booth frame; its stored id says which. */
describe("phone photos in booth frames (D93)", () => {
  it("no booth frame id could be mistaken for a phone photo", () => {
    for (const id of [...ALL_FRAMES.map((f) => f.id), ...RETIRED_FRAME_IDS]) {
      expect(id.startsWith(MOBILE_UPLOAD_CONFIG.frameIdPrefix), id).toBe(false);
      expect(id, id).not.toBe("photo");
      // Stored ids must pass the database check `^[a-z0-9-]{1,64}$`.
      expect(mobileFrameId(id)).toMatch(/^[a-z0-9-]{1,64}$/);
    }
  });

  it("the phone offers exactly the booth's frames (틀 선택 v2), never the dropped ones", () => {
    expect(MOBILE_FRAMES).toEqual(OFFERED_V2_FRAMES);
    for (const f of FRAMES) {
      expect(mobileOfferedFrame(f.id), f.id).toBeNull();
      expect(MOBILE_FRAMES).not.toContain(f);
    }
    for (const f of OFFERED_V2_FRAMES) expect(mobileOfferedFrame(f.id)).toBe(f);
    // Taken down on 2026-11-27: not offered for a new upload, still known for a stored one.
    for (const id of ["lace1", "polaroid3", "verse4"]) {
      expect(mobileOfferedFrame(id), id).toBeNull();
      expect(V2_FRAMES.some((f) => f.id === id)).toBe(true);
      expect(mobileBoothFrame(mobileFrameId(id))?.id).toBe(id);
    }
    for (const n of [1, 2, 3, 4])
      expect(mobileFramesFor(n).length, `${n} photos`).toBeGreaterThan(0);
    // A guest may pick more photos than any frame holds, and chooses among them.
    for (const f of MOBILE_FRAMES)
      expect(f.slots.length).toBeLessThanOrEqual(MOBILE_UPLOAD_CONFIG.maxPhotos);
  });

  it("plain and framed phone photos are both phone photos; booth photos are not", () => {
    expect(isMobilePhoto({ frameId: MOBILE_FRAME_ID })).toBe(true);
    expect(isMobilePhoto({ frameId: "phone-shalom-letter" })).toBe(true);
    expect(isMobilePhoto({ frameId: "shalom-letter" })).toBe(false);
    expect(photoSource({ frameId: "phone-shalom-grid" })).toBe("mobile");
  });

  it("a stored phone photo in any known frame (also a dropped one) hangs in that frame", () => {
    expect(isMobileFrameId(MOBILE_FRAME_ID)).toBe(true);
    for (const f of ALL_FRAMES) {
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
    for (const f of MOBILE_FRAMES)
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

  it("picking: at most six kept in the picker's order", () => {
    expect(limitPicked([1, 2, 3], 6)).toEqual({ kept: [1, 2, 3], dropped: 0 });
    expect(limitPicked([1, 2, 3, 4, 5, 6, 7, 8], 6)).toEqual({
      kept: [1, 2, 3, 4, 5, 6],
      dropped: 2,
    });
    // Picking more later fills only the room left.
    expect(limitPicked([7, 8, 9], 6 - 4)).toEqual({ kept: [7, 8], dropped: 1 });
    expect(limitPicked([7], 0)).toEqual({ kept: [], dropped: 1 });
  });

  // D103: the phone chooses photos for a frame the way the booth does.
  it("choosing: photos go in in the order tapped, never more than the frame holds", () => {
    let chosen: number[] = [];
    for (const i of [3, 0, 5]) chosen = toggleOrdered(chosen, i, 4);
    expect(chosen).toEqual([3, 0, 5]);
    expect(toggleOrdered(chosen, 0, 4)).toEqual([3, 5]);
    chosen = toggleOrdered(chosen, 1, 4);
    expect(chosen).toEqual([3, 0, 5, 1]);
    // Full: a fifth tap changes nothing until one is taken out.
    expect(toggleOrdered(chosen, 2, 4)).toEqual([3, 0, 5, 1]);
  });

  it("choosing: exactly as many photos as the frame holds are chosen for the guest", () => {
    expect(settleSelection([], 4, 4)).toEqual([0, 1, 2, 3]);
    expect(settleSelection([], 6, 4)).toEqual([]);
    expect(settleSelection([], 2, 4)).toEqual([]);
    // The guest's own choice stays, in its order; a smaller frame keeps the first ones tapped.
    expect(settleSelection([2, 0], 6, 4)).toEqual([2, 0]);
    expect(settleSelection([5, 2, 0], 6, 1)).toEqual([5]);
    expect(settleSelection([5, 1], 3, 4)).toEqual([1]);
  });
});
