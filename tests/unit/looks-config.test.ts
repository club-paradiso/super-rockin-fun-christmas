// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { V2_FRAMES } from "@/config/frames/v2";
import { LOOKS, LOOK_IDS, NO_LOOK, getLook, lookCubeUrl } from "@/config/looks";
import { chosenLook } from "@/lib/looks/booth";
import {
  FRAME_LOOKS,
  frameLookProblems,
  frameToneIsFixed,
  lookForFrame,
  looksEnabled,
  type FrameLookMap,
} from "@/lib/looks/config";

const frameIds = V2_FRAMES.map((frame) => frame.id);

describe("config/looks/frame-looks.json", () => {
  it("lists every booth frame, names only real looks, strengths 0–1", () => {
    expect(frameLookProblems(FRAME_LOOKS, frameIds)).toEqual([]);
  });

  it("every frame starts with no look (원본): the guest chooses one (a user decision, 2026-11-26)", () => {
    expect(FRAME_LOOKS.default.look).toBe(NO_LOOK);
    for (const frame of V2_FRAMES) {
      expect(FRAME_LOOKS.frames[frame.id]!.look, frame.id).toBe(NO_LOOK);
      expect(lookForFrame(frame.id), frame.id).toBeNull();
    }
    // An unlisted frame gets the default: no look either.
    expect(lookForFrame("some-future-frame")).toBeNull();
  });

  it("a frame may still name a look; an unlisted one gets the default", () => {
    const map: FrameLookMap = {
      default: { look: "paper", strength: 1 },
      frames: { "film4-cream": { look: "linen", strength: 0.8 } },
    };
    expect(lookForFrame("film4-cream", map)).toMatchObject({
      look: { id: "linen" },
      strength: 0.8,
    });
    expect(lookForFrame("some-future-frame", map)?.look.id).toBe("paper");
    expect(frameLookProblems(map, ["film4-cream"])).toEqual([]);
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
      expect(look.halation).toBeGreaterThanOrEqual(0);
      expect(look.halation).toBeLessThanOrEqual(0.8);
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

describe("frames whose tone is the concept (흑백, 세피아)", () => {
  it("are every frame drawn in black and white or sepia, and only those", () => {
    for (const frame of V2_FRAMES)
      expect(frameToneIsFixed(frame.id), frame.id).toBe(
        frame.photoTone === "mono" || frame.photoTone === "sepia",
      );
    expect(frameToneIsFixed("film3-mono-logo")).toBe(true);
    expect(frameToneIsFixed("film35-sepia")).toBe(true);
    expect(frameToneIsFixed("film35-natural")).toBe(false);
    expect(frameToneIsFixed("no-such-frame")).toBe(false);
    expect(frameToneIsFixed(null)).toBe(false);
  });

  it("never take a look into the print, whatever was asked", () => {
    for (const lookId of [...LOOK_IDS, NO_LOOK])
      expect(chosenLook("film3-mono-logo", lookId), lookId).toBeUndefined();
    expect(chosenLook("film35-natural", "ink")).toEqual({ lookId: "ink" });
  });
});
