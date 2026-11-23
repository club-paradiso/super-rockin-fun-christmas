// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { V2_FRAMES } from "@/config/frames/v2";
import { LOOKS, LOOK_IDS, getLook, lookCubeUrl } from "@/config/looks";
import {
  FRAME_LOOKS,
  frameLookProblems,
  lookForFrame,
  looksEnabled,
  type FrameLookMap,
} from "@/lib/looks/config";

const frameIds = V2_FRAMES.map((frame) => frame.id);

describe("config/looks/frame-looks.json", () => {
  it("lists every booth frame, names only real looks, strengths 0–1", () => {
    expect(frameLookProblems(FRAME_LOOKS, frameIds)).toEqual([]);
  });

  it("a black and white frame gets a black and white look, a colour frame a colour look", () => {
    for (const frame of V2_FRAMES) {
      const mono = !!lookForFrame(frame.id)!.look.grade.mono;
      expect(mono, frame.id).toBe(frame.photoTone === "mono" || frame.photoTone === "sepia");
    }
  });

  it("an unlisted frame gets the default look", () => {
    expect(lookForFrame("some-future-frame")?.look.id).toBe(FRAME_LOOKS.default.look);
  });

  it("says what is wrong with a bad file", () => {
    const bad: FrameLookMap = {
      default: { look: "nope", strength: 1 },
      frames: {
        [frameIds[0]!]: { look: "paper", strength: 1.4 },
        "not-a-frame": { look: "paper", strength: 1 },
      },
    };
    const problems = frameLookProblems(bad, frameIds.slice(0, 2));
    expect(problems).toContain('default: unknown look "nope"');
    expect(problems).toContain(`frames.${frameIds[0]}: strength must be 0–1`);
    expect(problems).toContain("frames.not-a-frame: no such frame");
    expect(problems).toContain(`frames.${frameIds[1]}: missing (list every frame)`);
    expect(lookForFrame("anything", bad)).toBeNull();
  });
});

describe("the looks", () => {
  it("six to eight candidates, each with its own id", () => {
    expect(LOOKS.length).toBeGreaterThanOrEqual(6);
    expect(LOOKS.length).toBeLessThanOrEqual(8);
    expect(new Set(LOOK_IDS).size).toBe(LOOKS.length);
    expect(getLook("paper")?.name).toBe("Paper");
    expect(getLook("no-such-look")).toBeUndefined();
    expect(lookCubeUrl("ink")).toBe("/looks/ink.cube");
  });

  it("names: one short English word, its Hangul, and no film or app trademark", () => {
    const trademarks =
      /portra|kodak|fuji|superia|velvia|provia|ektar|gold|tri-?x|ilford|hp5|cinestill|vsco|huji|dazz|tezza|polaroid|instax|leica|reala|classic chrome/i;
    for (const look of LOOKS) {
      expect(look.name).toMatch(/^[A-Z][a-z]{2,7}$/);
      expect(look.nameKo).toMatch(/^[가-힣]{2,4}$/);
      expect(look.name).not.toMatch(trademarks);
      expect(look.id).toBe(look.name.toLowerCase());
    }
  });

  it("each says what it looks like and why, and stays within sane numbers", () => {
    for (const look of LOOKS) {
      expect(look.summary.length).toBeGreaterThan(10);
      expect(look.why.length).toBeGreaterThan(30);
      expect(look.strength).toBeGreaterThan(0);
      expect(look.strength).toBeLessThanOrEqual(1);
      expect(look.grain.amount).toBeGreaterThan(0);
      expect(look.grain.amount).toBeLessThanOrEqual(0.03);
      expect(look.vignette).toBeGreaterThanOrEqual(0);
      expect(look.vignette).toBeLessThanOrEqual(0.4);
    }
  });

  it("every existing tone has an improved version among them", () => {
    expect(
      LOOKS.map((look) => look.replaces)
        .filter(Boolean)
        .sort(),
    ).toEqual(["film", "flash", "mono", "sepia"].sort());
  });
});

describe("the feature flag", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is off unless asked for", () => {
    vi.stubEnv("NEXT_PUBLIC_LOOKS", "");
    expect(looksEnabled()).toBe(false);
    expect(looksEnabled("")).toBe(false);
    expect(looksEnabled("?camera=mock")).toBe(false);
    expect(looksEnabled("?looks=yes")).toBe(false);
  });

  it("the build can turn it on, and the address can turn it on or off for one tablet", () => {
    expect(looksEnabled("?looks=1")).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_LOOKS", "1");
    expect(looksEnabled()).toBe(true);
    expect(looksEnabled("?camera=mock")).toBe(true);
    expect(looksEnabled("?looks=0")).toBe(false);
  });
});
