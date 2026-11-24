import { afterEach, describe, expect, it, vi } from "vitest";
import { V2_FRAMES } from "@/config/frames/v2";
import {
  looksActive,
  looksEnabled,
  looksOverride,
  lookViewForFrame,
  sessionLooks,
} from "@/lib/looks/config";
import { looksStatus, type LooksStatusInput } from "@/lib/looks/status";

afterEach(() => vi.unstubAllEnvs());

describe("who decides whether a booth applies looks", () => {
  it("the address says yes, no, or nothing", () => {
    expect(looksOverride("?looks=1")).toBe(true);
    expect(looksOverride("?camera=mock&looks=0")).toBe(false);
    expect(looksOverride("?looks=yes")).toBeNull();
    expect(looksOverride("")).toBeNull();
    expect(looksOverride(undefined)).toBeNull();
  });

  it("off unless the build, the staff switch or the address turns it on", () => {
    expect(looksActive("", false)).toBe(false);
    expect(looksActive("", true)).toBe(true);
    expect(looksActive("?looks=1", false)).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_LOOKS", "1");
    expect(looksActive("", false)).toBe(true);
    expect(looksEnabled("")).toBe(true);
  });

  it("the address wins over the staff switch and the build: one tablet can be held back", () => {
    vi.stubEnv("NEXT_PUBLIC_LOOKS", "1");
    expect(looksActive("?looks=0", true)).toBe(false);
    expect(looksEnabled("?looks=0")).toBe(false);
  });
});

describe("a change of the staff switch waits for the next guest", () => {
  it("is taken up on the start screen", () => {
    expect(sessionLooks("attract", false, true)).toBe(true);
    expect(sessionLooks("attract", true, false)).toBe(false);
  });

  it("never changes under a guest, in any later phase", () => {
    for (const phase of ["welcome", "pick", "options", "ready", "countdown", "review", "select"]) {
      expect(sessionLooks(phase, false, true)).toBe(false);
      expect(sessionLooks(phase, true, false)).toBe(true);
    }
    for (const phase of ["consent", "delivery"])
      expect(sessionLooks(phase, true, false)).toBe(true);
  });
});

describe("the live camera picture", () => {
  it("is black and white for a black-and-white frame, warm for a sepia one", () => {
    expect(lookViewForFrame("film35-mono")).toBe("mono");
    expect(lookViewForFrame("film3-mono-logo")).toBe("mono");
    expect(lookViewForFrame("film35-sepia")).toBe("sepia");
    expect(lookViewForFrame("film3-sepia-plain")).toBe("sepia");
  });

  it("is left alone for every colour frame", () => {
    const changed = V2_FRAMES.filter((frame) => lookViewForFrame(frame.id) !== null).map(
      (frame) => frame.id,
    );
    expect(changed.sort()).toEqual(
      V2_FRAMES.map((frame) => frame.id)
        .filter((id) => /-(mono|sepia)(-|$)/.test(id))
        .sort(),
    );
    expect(lookViewForFrame("film4-cream")).toBeNull();
  });

  it("is left alone when a mono look is mapped too weakly to read as black and white", () => {
    const map = { default: { look: "ink", strength: 0.3 }, frames: {} };
    expect(lookViewForFrame("anything", map)).toBeNull();
  });
});

describe("the staff line in the booth's help menu", () => {
  const base: LooksStatusInput = {
    staffSwitch: false,
    session: false,
    override: null,
    buildFlag: false,
    loaded: false,
    problem: null,
  };
  const line = (patch: Partial<LooksStatusInput>) => looksStatus({ ...base, ...patch });

  it("off, and where to turn it on", () => {
    expect(line({})).toEqual({ state: "off", text: "꺼짐 · 관리자 화면에서 켤 수 있어요." });
  });

  it("switched on while a guest is at the booth: off for them, on for the next", () => {
    expect(line({ staffSwitch: true })).toEqual({
      state: "off",
      text: "꺼짐 · 다음 손님부터 켜져요.",
    });
  });

  it("on, loading, then on", () => {
    expect(line({ staffSwitch: true, session: true }).state).toBe("loading");
    expect(line({ staffSwitch: true, session: true, loaded: true })).toEqual({
      state: "on",
      text: "켜짐",
    });
  });

  it("switched off while a guest is at the booth: still on for them", () => {
    expect(line({ session: true, loaded: true })).toEqual({
      state: "on",
      text: "켜짐 · 다음 손님부터 꺼져요.",
    });
  });

  it("WebGL failed: says so with the reason, never 'on'", () => {
    const failed = line({ staffSwitch: true, session: true, loaded: true, problem: "no WebGL" });
    expect(failed.state).toBe("failed");
    expect(failed.text).toContain("예전 색으로 나가요");
    expect(failed.text).toContain("no WebGL");
  });

  it("this tablet's address overrides the switch, and the line says which way", () => {
    expect(line({ staffSwitch: true, session: true, loaded: true, override: false })).toEqual({
      state: "off",
      text: "꺼짐 · 이 태블릿은 주소(?looks=0)로 꺼 두었어요.",
    });
    expect(line({ override: true, loaded: true }).text).toContain("?looks=1");
    expect(line({ buildFlag: true, loaded: true })).toEqual({ state: "on", text: "켜짐" });
  });
});
