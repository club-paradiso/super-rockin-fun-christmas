import { describe, expect, it } from "vitest";
import { KIOSK_CONFIG } from "@/config/kiosk";
import { POSE_SEQUENCE } from "@/config/poses";

describe("pose guide data (D71)", () => {
  it("has exactly one pose per shot", () => {
    expect(POSE_SEQUENCE.length).toBe(KIOSK_CONFIG.shotsPerSession);
  });

  it("every pose has an id and a short label; with four shots the first pose gets two tries", () => {
    const counts = new Map<string, number>();
    for (const pose of POSE_SEQUENCE) {
      expect(pose.id).toMatch(/^[a-z-]+$/);
      expect(pose.label.length).toBeGreaterThan(0);
      expect(pose.label.length).toBeLessThanOrEqual(12);
      counts.set(pose.id, (counts.get(pose.id) ?? 0) + 1);
    }
    // Four shots (2026-11-27), three poses in turn and the first once more.
    expect(POSE_SEQUENCE).toHaveLength(4);
    expect([...counts.values()].sort()).toEqual([1, 1, 2]);
  });

  it("every pose has an English and a Chinese label (D78, D89)", () => {
    for (const pose of POSE_SEQUENCE) {
      expect(pose.labelEn).toBeTruthy();
      expect(pose.labelEn).not.toMatch(/[\uac00-\ud7a3]/);
      expect(pose.labelZh).toMatch(/\p{Script=Han}/u);
    }
  });

  it("the standard countdown is 5 s unless the test-only override is set", () => {
    expect(KIOSK_CONFIG.countdownSeconds).toBe(5);
  });
});
