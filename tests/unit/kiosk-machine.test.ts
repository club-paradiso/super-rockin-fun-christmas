import { describe, expect, it } from "vitest";
import { POSE_SEQUENCE } from "@/config/poses";
import { getFrame } from "@/config/frames";
import { HAND_FONTS } from "@/config/hand-fonts";
import {
  OFFERED_CARDS,
  POLAROID1_CAPTIONS,
  POLAROID1_RETIRED_CAPTIONS,
  RETIRED_CARD_IDS,
} from "@/config/frames/v2";
import { KIOSK_CONFIG } from "@/config/kiosk";
import { KIOSK_COPY } from "@/lib/kiosk/copy";
import {
  MAX_CAPTURE_FAILURES,
  canGoBack,
  isShooting,
  needsCamera,
  capturedCount,
  createInitialState as attractState,
  currentPose,
  kioskReducer,
  progressStep,
  sessionAsksConsent,
  type KioskAction,
  type KioskState,
} from "@/lib/kiosk/machine";

type S = KioskState<string>;

/**
 * Most tests start where a guest has touched the cover (D80): since 2026-11-27 that one touch
 * starts the session and opens the frame picker.
 */
function createInitialState<Shot>(init: Parameters<typeof attractState>[0]): KioskState<Shot> {
  return kioskReducer(attractState<Shot>(init), { type: "OPEN", sessionId: SESSION });
}
const SESSION = "11111111-2222-4333-8444-555555555555";
/** Shots per session: four, 5 s apart, final since 2026-11-27 (a user decision). */
const SHOTS = KIOSK_CONFIG.shotsPerSession;

function init(): S {
  return createInitialState<string>({ shotCount: SHOTS, countdownSeconds: 3 });
}

/** The cover, before anyone has touched it. */
function cover(): S {
  return attractState<string>({ shotCount: SHOTS, countdownSeconds: 3 });
}

function run(state: S, ...actions: KioskAction<string>[]): S {
  return actions.reduce(kioskReducer<string>, state);
}

/** 필름 3컷 (the default card) → its options → the camera. */
const toReady = (s = init()) =>
  run(
    s,
    { type: "CONFIRM_PICK", random: 0 },
    { type: "CONFIRM_OPTIONS", random: 0 },
    { type: "CAMERA_READY" },
  );
const ticks = (n: number) => Array.from({ length: n }, () => ({ type: "TICK" }) as const);

/** Count down and capture one shot. */
const shoot = (s: S, label: string) =>
  run(s, ...ticks(s.remaining), { type: "SHOT_CAPTURED", shot: label });

function shootAll(ready: S): S {
  let s = run(ready, { type: "BEGIN_SHOOTING", guide: false });
  for (let i = 0; i < SHOTS; i++) s = shoot(s, `shot-${i}`);
  return s;
}
/** Every shot taken: the photo choice, as it opens (there is no review screen since 2026-11-27). */
const toShot = (): S => shootAll(toReady());

/** A card (and its options) on the picker, then the camera and the four shots. */
function toShotWith(cardId: string, options: KioskAction<string>[] = []): S {
  let s = run(init(), { type: "SELECT_CARD", cardId });
  s = run(s, { type: "CONFIRM_PICK", random: 0 });
  if (s.phase === "options") s = run(s, ...options, { type: "CONFIRM_OPTIONS", random: 0 });
  return shootAll(run(s, { type: "CAMERA_READY" }));
}

/**
 * The photo choice as it opens (the first photos already chosen) → the wall question (or the
 * QR): one press, nothing else.
 */
const selectAll = (shot: S, askConsent: boolean) =>
  run(shot, { type: "CONFIRM_SELECTION", askConsent });

/** The photo choice with nothing chosen (the guest took every photo out again). */
const cleared = (s: S): S =>
  run(
    s,
    ...s.selectedShotIndices.map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const),
  );

describe("countdown", () => {
  it("counts 3 → 2 → 1 → capturing", () => {
    let s = run(toReady(), { type: "BEGIN_SHOOTING", guide: false });
    expect(s.phase).toBe("countdown");
    expect(s.remaining).toBe(3);
    s = run(s, { type: "TICK" });
    expect([s.phase, s.remaining]).toEqual(["countdown", 2]);
    s = run(s, { type: "TICK" });
    expect([s.phase, s.remaining]).toEqual(["countdown", 1]);
    s = run(s, { type: "TICK" });
    expect(s.phase).toBe("capturing");
  });

  it("ignores ticks outside the countdown", () => {
    const ready = toReady();
    expect(run(ready, { type: "TICK" })).toBe(ready);
  });

  it("restarts the countdown for every shot", () => {
    let s = run(toReady(), { type: "BEGIN_SHOOTING", guide: false });
    s = shoot(s, "a");
    expect([s.phase, s.shotIndex, s.remaining]).toEqual(["countdown", 1, 3]);
  });
});

describe("the breather between two shots (2026-11-27, a user decision)", () => {
  // 5 s countdown → flash → a short rest → 5 s countdown. The rest is a phase of its own.
  const withRest = () =>
    run(
      createInitialState<string>({ shotCount: SHOTS, countdownSeconds: 3, restSeconds: 2 }),
      { type: "CONFIRM_PICK", random: 0 },
      { type: "CONFIRM_OPTIONS", random: 0 },
      { type: "CAMERA_READY" },
      { type: "BEGIN_SHOOTING", guide: false },
    );

  it("after a shot the booth rests, then counts down the next one", () => {
    const taken = run(withRest(), ...ticks(3), { type: "SHOT_CAPTURED", shot: "a" });
    expect([taken.phase, taken.shotIndex]).toEqual(["rest", 1]);
    expect(taken.shots[0]).toBe("a");
    const next = run(taken, { type: "REST_DONE" });
    expect([next.phase, next.shotIndex, next.remaining]).toEqual(["countdown", 1, 3]);
  });

  it("no rest after the last shot: the photo choice follows at once", () => {
    let s = withRest();
    for (let i = 0; i < SHOTS; i++) {
      s = shoot(s, `shot-${i}`);
      if (i < SHOTS - 1) {
        expect(s.phase).toBe("rest");
        s = run(s, { type: "REST_DONE" });
      }
    }
    expect(s.phase).toBe("select");
  });

  it("a rest is not a countdown: a tick, a stray capture or a second REST_DONE change nothing", () => {
    const rest = run(withRest(), ...ticks(3), { type: "SHOT_CAPTURED", shot: "a" });
    expect(run(rest, { type: "TICK" })).toBe(rest);
    expect(run(rest, { type: "SHOT_CAPTURED", shot: "b" })).toBe(rest);
    const counting = run(rest, { type: "REST_DONE" });
    expect(run(counting, { type: "REST_DONE" })).toBe(counting);
    expect(run(withRest(), { type: "REST_DONE" }).phase).toBe("countdown");
  });

  it("the rest is part of shooting: the camera stays on and there is no way back, a lost camera is an error", () => {
    const rest = run(withRest(), ...ticks(3), { type: "SHOT_CAPTURED", shot: "a" });
    expect(needsCamera(rest.phase)).toBe(true);
    expect(isShooting(rest.phase)).toBe(true);
    expect(canGoBack(rest)).toBe(false);
    expect(run(rest, { type: "CAMERA_FAILED", kind: "failed" } as never).phase).toBe(
      "camera-error",
    );
  });

  it("the pose guide shows the next shot's pose during the rest", () => {
    const guided = run(
      createInitialState<string>({ shotCount: SHOTS, countdownSeconds: 3, restSeconds: 2 }),
      { type: "CONFIRM_PICK", random: 0 },
      { type: "CONFIRM_OPTIONS", random: 0 },
      { type: "CAMERA_READY" },
      { type: "BEGIN_SHOOTING", guide: true },
      ...ticks(3),
      { type: "SHOT_CAPTURED", shot: "a" },
    );
    expect(guided.phase).toBe("rest");
    expect(currentPose(guided)).toEqual(POSE_SEQUENCE[1]);
  });

  it("restSeconds 0 (or absent) means no rest: straight on, as before", () => {
    const s = run(init(), ...[]);
    const taken = shoot(run(toReady(s), { type: "BEGIN_SHOOTING", guide: false }), "a");
    expect(taken.phase).toBe("countdown");
    expect(taken.restSeconds).toBe(0);
  });

  it("a new session keeps the rest setting", () => {
    const reset = run(withRest(), { type: "RESET" });
    expect(reset.restSeconds).toBe(2);
  });

  it("the booth's own setting is a short rest, not a pause: 1 to 5 s", () => {
    expect(KIOSK_CONFIG.restSeconds).toBeGreaterThanOrEqual(0);
    expect(KIOSK_CONFIG.restSeconds).toBeLessThanOrEqual(5);
  });
});

describe("exactly four captures (2026-11-27, a user decision)", () => {
  it("the booth shoots four", () => {
    expect(SHOTS).toBe(4);
  });

  it("goes to the photo choice after the fourth shot, in order, the first photos already chosen", () => {
    const s = toShot();
    expect(s.phase).toBe("select");
    expect(s.shots).toEqual(["shot-0", "shot-1", "shot-2", "shot-3"]);
    expect(capturedCount(s)).toBe(SHOTS);
    // 필름 3컷: the first three, in shooting order. One press finishes.
    expect(s.selectedShotIndices).toEqual([0, 1, 2]);
    expect(run(s, { type: "CONFIRM_SELECTION", askConsent: true }).phase).toBe("consent");
  });

  it("chooses as many as the frame takes, whatever the frame: 1, 2, 3 or 4", () => {
    for (const [card, slots] of [
      ["polaroid1", 1],
      ["check2", 2],
      ["film3", 3],
      ["film4", 4],
      ["meme4", 4],
    ] as const) {
      const s = toShotWith(card);
      expect(getFrame(s.frameId).slots.length, card).toBe(slots);
      expect(s.selectedShotIndices, card).toEqual(Array.from({ length: slots }, (_, i) => i));
      // No frame takes more than the session shoots: every shot has a place.
      expect(slots, card).toBeLessThanOrEqual(SHOTS);
    }
  });

  it("the countdown runs exactly four times", () => {
    let s = run(toReady(), { type: "BEGIN_SHOOTING", guide: false });
    const countdowns: number[] = [];
    for (let i = 0; i < SHOTS; i++) {
      expect(s.phase).toBe("countdown");
      countdowns.push(s.shotIndex);
      s = shoot(s, `shot-${i}`);
    }
    expect(countdowns).toEqual([0, 1, 2, 3]);
    expect(s.phase).toBe("select");
  });

  it("rejects a stray sixth frame", () => {
    const s = toShot();
    expect(run(s, { type: "SHOT_CAPTURED", shot: "extra" })).toBe(s);
  });

  it("does not accept a shot while still counting down", () => {
    const s = run(toReady(), { type: "BEGIN_SHOOTING", guide: false });
    expect(run(s, { type: "SHOT_CAPTURED", shot: "early" })).toBe(s);
  });

  it("the photo choice opens only when all four exist: three shots are still shooting", () => {
    let partial = run(toReady(), { type: "BEGIN_SHOOTING", guide: false });
    for (let i = 0; i < SHOTS - 1; i++) partial = shoot(partial, `p-${i}`);
    expect(partial.phase).toBe("countdown");
    expect(partial.selectedShotIndices).toEqual([]);
    // Nothing can be chosen or finished before the last shot, and the old step is gone.
    expect(run(partial, { type: "TOGGLE_SHOT_SELECTION", index: 0 })).toBe(partial);
    expect(run(partial, { type: "CONFIRM_SELECTION", askConsent: true })).toBe(partial);
    expect(run(partial, { type: "CONFIRM_SHOTS" } as never)).toBe(partial);
  });
});

describe("no extra photo, no second frame choice (v2)", () => {
  it("has no fifth slot: the session holds exactly four and an unknown action changes nothing", () => {
    const all = toShot();
    expect(all.shots).toHaveLength(SHOTS);
    expect("extraShotPending" in all).toBe(false);
    for (const type of [
      "TAKE_EXTRA_SHOT",
      "BACK_TO_FRAME",
      "CONFIRM_FRAME",
      "SELECT_FRAME",
      // The steps that went on 2026-11-27, from a page cached before it.
      "START",
      "CONFIRM_SHOTS",
    ])
      expect(run(all, { type } as never)).toBe(all);
  });

  it("after shooting the card, colour and logo cannot change", () => {
    const select = toShot();
    const s = run(
      select,
      { type: "SELECT_CARD", cardId: "polaroid1" },
      { type: "PICK_CARD", cardId: "polaroid1", random: 0 },
      { type: "CONFIRM_PICK", random: 0 },
      { type: "SET_OPTION", key: "color", value: "sepia" },
      { type: "CONFIRM_OPTIONS", random: 0 },
      { type: "BACK" },
    );
    // Nothing moved: not the frame, not the screen. There is no "이전" from the photo choice.
    expect(s).toBe(select);
    expect(canGoBack(s)).toBe(false);
  });
});

describe("이전 where nothing is lost (2026-11-25, 2026-11-27)", () => {
  it("the photo choice has no way back: the shots, the choice and the look stay where they are", () => {
    const select = run(
      toShot(),
      { type: "TOGGLE_SHOT_SELECTION", index: 2 },
      { type: "TOGGLE_SHOT_SELECTION", index: 3 },
      { type: "SET_LOOK", lookId: "ink" },
    );
    expect(select.selectedShotIndices).toEqual([0, 1, 3]);
    expect(canGoBack(select)).toBe(false);
    expect(run(select, { type: "BACK" })).toBe(select);
  });

  it("never once the photos are chosen: the picture is being made and uploaded", () => {
    const consent = selectAll(toShot(), true);
    expect(consent.phase).toBe("consent");
    expect(canGoBack(consent)).toBe(false);
    expect(run(consent, { type: "BACK" })).toBe(consent);
    const delivery = run(consent, { type: "SET_CONSENT", consent: "no" });
    expect(canGoBack(delivery)).toBe(false);
  });

  it("the phone QR → the cover, until the phone's photo is in", () => {
    const waiting = run(cover(), { type: "START_MOBILE" });
    expect(waiting.phase).toBe("mobile");
    expect(canGoBack(waiting)).toBe(true);
    expect(run(waiting, { type: "BACK" })).toMatchObject({
      phase: "attract",
      mobile: { status: "idle" },
    });
    const ready = run(waiting, {
      type: "MOBILE_READY",
      sessionId: "m",
      url: "u",
      expiresAt: "e",
      via: "lan",
    });
    expect(run(ready, { type: "BACK" }).phase).toBe("attract");
    // A late answer about the QR that was left changes nothing.
    const left = run(ready, { type: "BACK" });
    expect(run(left, { type: "MOBILE_RECEIVED", sessionId: "m" })).toBe(left);
    const received = run(ready, { type: "MOBILE_RECEIVED", sessionId: "m" });
    expect(canGoBack(received)).toBe(false);
    expect(run(received, { type: "BACK" })).toBe(received);
  });

  it("never during shooting, after it or on the camera error", () => {
    const counting = run(toReady(), { type: "BEGIN_SHOOTING", guide: false });
    expect(canGoBack(counting)).toBe(false);
    expect(canGoBack(toShot())).toBe(false);
    const error = run(toReady(), { type: "CAMERA_FAILED", kind: "failed" });
    expect(canGoBack(error)).toBe(false);
  });
});

describe("no retake (2026-11-27, a user decision: 5 shots, no retake)", () => {
  it("nothing shoots again: an old RETAKE action changes nothing on any screen", () => {
    const select = toShot();
    const consent = selectAll(select, true);
    const shooting = run(toReady(), { type: "BEGIN_SHOOTING", guide: false });
    for (const state of [select, consent, shooting])
      expect(run(state, { type: "RETAKE" } as never)).toBe(state);
    // And the shots are still the guest's.
    expect(capturedCount(run(select, { type: "RETAKE" } as never))).toBe(SHOTS);
  });

  it("the state carries no retake allowance, whatever the booth is started with", () => {
    const s = createInitialState<string>({
      shotCount: SHOTS,
      countdownSeconds: 3,
      retakesPerSession: 3,
    } as never);
    expect("retakesLeft" in s).toBe(false);
    expect("retakesPerSession" in s).toBe(false);
    expect("retakesLeft" in toShot()).toBe(false);
  });

  it("after the last shot the only steps are forward (or home): no way back to the camera", () => {
    const select = toShot();
    expect(canGoBack(select)).toBe(false);
    expect(run(select, { type: "BACK" })).toBe(select);
    for (const type of ["CAMERA_RESTART", "CAMERA_RETRY", "BEGIN_SHOOTING", "CAMERA_READY"])
      expect(run(select, { type, guide: false } as never)).toBe(select);
  });
});

describe("failures", () => {
  it("retries a failed capture, then gives up to the camera error screen", () => {
    let s = run(toReady(), { type: "BEGIN_SHOOTING", guide: false }, ...ticks(3));
    s = run(s, { type: "CAPTURE_FAILED" });
    expect([s.phase, s.shotIndex]).toEqual(["countdown", 0]);
    for (let i = 1; i < MAX_CAPTURE_FAILURES; i++)
      s = run(s, ...ticks(3), { type: "CAPTURE_FAILED" });
    expect([s.phase, s.cameraError]).toEqual(["camera-error", "failed"]);
  });

  it("keeps earlier shots across a camera reconnect", () => {
    let s = run(toReady(), { type: "BEGIN_SHOOTING", guide: false });
    s = shoot(s, "a");
    s = shoot(s, "b");
    s = run(s, { type: "CAMERA_FAILED", kind: "missing" });
    expect(s.phase).toBe("camera-error");
    s = run(
      s,
      { type: "CAMERA_RETRY" },
      { type: "CAMERA_READY" },
      { type: "BEGIN_SHOOTING", guide: false },
    );
    expect([s.phase, s.shotIndex]).toEqual(["countdown", 2]);
    expect(s.shots.slice(0, 2)).toEqual(["a", "b"]);
  });
});

describe("틀 선택 v2: nine cards, options before shooting", () => {
  it("starts on 필름 3컷 with its defaults (흑백, 로고 넣기)", () => {
    const s = init();
    expect([s.phase, s.cardId, s.frameId]).toEqual(["pick", "film3", "film3-mono-logo"]);
    expect(s.frameOptions).toEqual({ color: "mono", logo: "logoOn" });
  });

  it("a card with options goes to the options screen (every card offered today has some)", () => {
    const pick = init();
    for (const id of ["film3", "film4", "check2", "polaroid1", "film35", "meme4"])
      expect(
        run(pick, { type: "SELECT_CARD", cardId: id }, { type: "CONFIRM_PICK", random: 0 }).phase,
      ).toBe("options");
    expect(OFFERED_CARDS.every((c) => c.options.length > 0)).toBe(true);
  });

  it("a card taken down (2026-11-27) cannot be chosen: it is the default card, never a broken session", () => {
    const pick = init();
    for (const id of RETIRED_CARD_IDS) {
      for (const action of [
        { type: "SELECT_CARD", cardId: id },
        { type: "PICK_CARD", cardId: id, random: 0 },
      ] as const) {
        const s = run(pick, action);
        expect([s.cardId, s.frameId], id).toEqual(["film3", "film3-mono-logo"]);
      }
    }
  });

  it("a tap on a card chooses it and goes on in one step (2026-11-27): the same place 고르기 + 다음 led to", () => {
    const pick = init();
    for (const id of ["film3", "film4", "check2", "polaroid1", "film35", "meme4"]) {
      const tapped = run(pick, { type: "PICK_CARD", cardId: id, random: 0 });
      expect([tapped.phase, tapped.cardId], id).toEqual(["options", id]);
      expect(tapped).toEqual(
        run(pick, { type: "SELECT_CARD", cardId: id }, { type: "CONFIRM_PICK", random: 0 }),
      );
    }
    // A card's options start at their defaults each time it is tapped, whatever was set before.
    const again = run(
      pick,
      { type: "PICK_CARD", cardId: "film3", random: 0 },
      { type: "SET_OPTION", key: "color", value: "sepia" },
      { type: "BACK" },
      { type: "PICK_CARD", cardId: "film3", random: 0 },
    );
    expect(again.frameId).toBe("film3-mono-logo");
    // An unknown card is the default card, as with SELECT_CARD: never a broken session.
    expect(run(pick, { type: "PICK_CARD", cardId: "nope", random: 0 }).cardId).toBe("film3");
  });

  it("a tap on a card works only on the picker", () => {
    for (const state of [cover(), toReady(), toShot(), selectAll(toShot(), true)])
      expect(run(state, { type: "PICK_CARD", cardId: "polaroid1", random: 0 })).toBe(state);
    const options = run(init(), { type: "CONFIRM_PICK", random: 0 });
    expect(run(options, { type: "PICK_CARD", cardId: "polaroid1", random: 0 })).toBe(options);
  });

  it("every option combination is its own frame", () => {
    const at = (cardId: string, ...opts: KioskAction<string>[]) =>
      run(init(), { type: "SELECT_CARD", cardId }, { type: "CONFIRM_PICK", random: 0 }, ...opts)
        .frameId;
    const set = (key: "color" | "logo", value: string) =>
      ({ type: "SET_OPTION", key, value }) as KioskAction<string>;
    expect(at("film3")).toBe("film3-mono-logo");
    expect(at("film3", set("logo", "logoOff"))).toBe("film3-mono-plain");
    expect(at("film3", set("color", "sepia"))).toBe("film3-sepia-logo");
    expect(at("film3", set("color", "sepia"), set("logo", "logoOff"))).toBe("film3-sepia-plain");
    expect(at("film4")).toBe("film4-cream");
    expect(at("film4", set("color", "red"))).toBe("film4-red");
    expect(at("check2")).toBe("check2-red");
    expect(at("check2", set("color", "blue"))).toBe("check2-blue");
    // A value another card offers is refused.
    expect(at("film4", set("color", "blue"))).toBe("film4-cream");
    expect(at("check2", set("logo", "logoOff"))).toBe("check2-red");
  });

  it("back: options → pick, camera before the first shot → options (or the pick)", () => {
    let s = run(init(), { type: "CONFIRM_PICK", random: 0 });
    expect(s.phase).toBe("options");
    expect(run(s, { type: "BACK" }).phase).toBe("pick");
    s = run(s, { type: "CONFIRM_OPTIONS", random: 0 }, { type: "CAMERA_READY" });
    expect(run(s, { type: "BACK" }).phase).toBe("options");
    const shot = shoot(run(s, { type: "BEGIN_SHOOTING", guide: false }), "a");
    expect(canGoBack(shot)).toBe(false);
  });

  it("does not start the camera or change the frame from other screens", () => {
    const closed = cover();
    expect(run(closed, { type: "CONFIRM_PICK", random: 0 })).toBe(closed);
    expect(run(closed, { type: "CONFIRM_OPTIONS", random: 0 })).toBe(closed);
    expect(run(closed, { type: "SELECT_CARD", cardId: "polaroid1" })).toBe(closed);
    const pick = init();
    expect(run(pick, { type: "CONFIRM_OPTIONS", random: 0 })).toBe(pick);
    const select = toShot();
    expect(run(select, { type: "SELECT_CARD", cardId: "polaroid1" })).toBe(select);
  });

  it("asks the wall question unless submissions are paused", () => {
    expect(toShot().phase).toBe("select");
    expect(selectAll(toShot(), true).phase).toBe("consent");
    expect(selectAll(toShot(), false).phase).toBe("delivery");
  });
});

describe("handwriting font (film 4컷, polaroid 1컷)", () => {
  const lockAt = (s: S, cardId: string, random: number) => {
    let next = run(s, { type: "SELECT_CARD", cardId });
    next = run(next, { type: "CONFIRM_PICK", random });
    if (next.phase === "options") next = run(next, { type: "CONFIRM_OPTIONS", random });
    return next;
  };

  it("is drawn when shooting starts, only for frames that carry handwriting", () => {
    expect(lockAt(init(), "film4", 0).handFont).toBe(HAND_FONTS[0]!.id);
    expect(lockAt(init(), "polaroid1", 0.99).handFont).toBe(HAND_FONTS[9]!.id);
    expect(lockAt(init(), "film3", 0).handFont).toBeNull();
    expect(lockAt(init(), "check2", 0).handFont).toBeNull();
  });

  it("never repeats the previous session's font: 20 sessions in a row", () => {
    let s = init();
    let previous: string | null = null;
    let repeats = 0;
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      // The worst case for a naive pick: always the same random number.
      s = lockAt(s, i % 2 ? "film4" : "polaroid1", 0);
      if (s.handFont === previous) repeats++;
      seen.add(s.handFont!);
      previous = s.handFont;
      s = run(s, { type: "RESET" }, { type: "OPEN", sessionId: SESSION });
    }
    expect(repeats).toBe(0);
    expect(seen.size).toBeGreaterThan(1);
  });

  it("is kept across a reload through the initial state", () => {
    const s = createInitialState<string>({
      shotCount: SHOTS,
      countdownSeconds: 3,
      lastHandFont: HAND_FONTS[0]!.id,
    });
    expect(lockAt(s, "film4", 0).handFont).not.toBe(HAND_FONTS[0]!.id);
    const unknown = createInitialState<string>({
      shotCount: SHOTS,
      countdownSeconds: 3,
      lastHandFont: "x",
    });
    expect(unknown.lastHandFont).toBeNull();
  });
});

describe("delivery and consent are independent", () => {
  const toConsent = () => selectAll(toShot(), true);
  const ready = {
    type: "DELIVERY_SUCCEEDED",
    token: "t",
    url: "https://x/p/t",
    expiresAt: "2026-12-27T00:00:00Z",
  } as const;

  it("the upload runs while the guest answers; declining keeps the link", () => {
    let s = run(toConsent(), { type: "DELIVERY_STARTED" }, ready);
    expect([s.phase, s.delivery.status]).toEqual(["consent", "ready"]);
    s = run(s, { type: "SET_CONSENT", consent: "no" });
    expect(s.phase).toBe("delivery");
    expect(s.consent).toBe("no");
    expect(s.delivery).toMatchObject({ status: "ready", token: "t" });
    s = run(s, { type: "SET_CONSENT", consent: "yes" });
    expect(s.consent).toBe("no"); // answered once; the QR screen cannot change it
  });

  it("the QR may arrive after the answer", () => {
    let s = run(toConsent(), { type: "DELIVERY_STARTED" }, { type: "SET_CONSENT", consent: "yes" });
    expect([s.phase, s.delivery.status]).toEqual(["delivery", "uploading"]);
    s = run(s, ready);
    expect(s.delivery.status).toBe("ready");
  });

  it("hub + cloud: QR pending → link arrives → ready; pending never replaces a ready QR", () => {
    let s = run(toConsent(), { type: "DELIVERY_STARTED" }, { type: "DELIVERY_QR_PENDING" });
    expect(s.delivery).toEqual({ status: "qr-pending" });
    s = run(s, ready);
    expect(s.delivery).toMatchObject({ status: "ready", url: "https://x/p/t" });
    s = run(s, { type: "DELIVERY_QR_PENDING" });
    expect(s.delivery.status).toBe("ready");
  });

  it("offline: the photo waits on the device and the guest still answers", () => {
    const s = run(
      toConsent(),
      { type: "DELIVERY_QUEUED", reason: "network" },
      { type: "SET_CONSENT", consent: "yes" },
    );
    expect([s.phase, s.consent, s.delivery.status]).toEqual(["delivery", "yes", "queued"]);
  });

  it("ignores delivery events before the photos are chosen", () => {
    const select = run(toShot());
    expect(run(select, ready)).toBe(select);
    expect(run(select, { type: "DELIVERY_STARTED" })).toBe(select);
  });
});

describe("progress", () => {
  it("five steps (틀 → 촬영 → 사진 고르기 → 동의 → QR), four while submissions are paused", () => {
    // Six and five until 2026-11-27, when the review screen went: the dots count real steps.
    expect(progressStep("attract", true)).toBeNull();
    expect(progressStep("mobile", true)).toBeNull();
    expect(progressStep("pick", true)).toEqual({ step: 1, total: 5 });
    expect(progressStep("options", true)).toEqual({ step: 1, total: 5 });
    for (const phase of ["camera", "ready", "countdown", "capturing", "camera-error"] as const)
      expect(progressStep(phase, true), phase).toEqual({ step: 2, total: 5 });
    expect(progressStep("select", true)).toEqual({ step: 3, total: 5 });
    expect(progressStep("consent", true)).toEqual({ step: 4, total: 5 });
    expect(progressStep("delivery", true)).toEqual({ step: 5, total: 5 });
    expect(progressStep("pick", false)).toEqual({ step: 1, total: 4 });
    expect(progressStep("select", false)).toEqual({ step: 3, total: 4 });
    expect(progressStep("delivery", false)).toEqual({ step: 4, total: 4 });
    // No screen is a step that does not exist any more.
    expect(progressStep("review" as never, true)).toEqual({ step: 2, total: 5 });
  });

  it("the steps of a whole session never skip a dot and never go back", () => {
    const seen: number[] = [];
    const note = (s: S) => {
      const p = progressStep(s.phase, true);
      if (p && seen[seen.length - 1] !== p.step) seen.push(p.step);
    };
    let s = init();
    note(s);
    s = run(s, { type: "PICK_CARD", cardId: "film3", random: 0 });
    note(s);
    s = run(s, { type: "CONFIRM_OPTIONS", random: 0 }, { type: "CAMERA_READY" });
    note(s);
    s = shootAll(s);
    note(s);
    s = run(s, { type: "CONFIRM_SELECTION", askConsent: true });
    note(s);
    s = run(s, { type: "SET_CONSENT", consent: "yes" });
    note(s);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it("the dots follow what this session really does: fixed once the photos are chosen", () => {
    // Before that, it is what would happen now (the staff switch as the booth last heard it).
    const before = toShotWith("polaroid1");
    expect(before.consentAsked).toBeNull();
    expect(sessionAsksConsent(before, true)).toBe(true);
    expect(sessionAsksConsent(before, false)).toBe(false);

    // (The first photo is chosen already when the screen opens.)
    const chosen = before;
    // Asked: five dots to the end, even if staff pause submissions while the guest answers.
    const asked = run(chosen, { type: "CONFIRM_SELECTION", askConsent: true });
    expect([asked.phase, asked.consentAsked]).toEqual(["consent", true]);
    expect(progressStep(asked.phase, sessionAsksConsent(asked, false))).toEqual({
      step: 4,
      total: 5,
    });
    const answered = run(asked, { type: "SET_CONSENT", consent: "no" });
    expect(progressStep(answered.phase, sessionAsksConsent(answered, false))).toEqual({
      step: 5,
      total: 5,
    });
    // Skipped: four dots to the end, even if staff open submissions again on the QR screen.
    const skipped = run(chosen, { type: "CONFIRM_SELECTION", askConsent: false });
    expect([skipped.phase, skipped.consentAsked]).toEqual(["delivery", false]);
    expect(progressStep(skipped.phase, sessionAsksConsent(skipped, true))).toEqual({
      step: 4,
      total: 4,
    });
    // The next guest starts undecided again.
    expect(run(skipped, { type: "RESET" }).consentAsked).toBeNull();
  });
});

describe("reset", () => {
  it("clears the previous session entirely", () => {
    const done = run(
      selectAll(toShotWith("film4", [{ type: "SET_OPTION", key: "color", value: "red" }]), true),
      { type: "DELIVERY_SUCCEEDED", token: "t", url: "u", expiresAt: "e" },
      { type: "SET_CONSENT", consent: "yes" },
    );
    expect(done.frameId).toBe("film4-red");
    const s = run(done, { type: "RESET" });
    expect(s.phase).toBe("attract");
    expect(s.sessionId).toBe("");
    expect(s.shots).toEqual(Array.from({ length: SHOTS }, () => null));
    expect(s.delivery).toEqual({ status: "idle" });
    expect(s.consent).toBeNull();
    // Every guest starts on 필름 3컷 (v2); only the font is remembered, so the next one differs.
    expect([s.cardId, s.frameId, s.handFont]).toEqual(["film3", "film3-mono-logo", null]);
    expect(s.lastHandFont).toBe(done.handFont);
  });

  it("each touch on the cover begins a new session id", () => {
    const a = run(cover(), { type: "OPEN", sessionId: "a" });
    const b = run(a, { type: "RESET" }, { type: "OPEN", sessionId: "b" });
    expect([a.sessionId, b.sessionId]).toEqual(["a", "b"]);
    // A session never starts without an id, and never twice.
    expect(run(cover(), { type: "OPEN", sessionId: "" })).toEqual(cover());
    expect(run(cover(), { type: "OPEN" } as never)).toEqual(cover());
    expect(run(a, { type: "OPEN", sessionId: "c" })).toBe(a);
  });
});

describe("the colour look a guest chooses with the photos", () => {
  const choosing = () => toShotWith("film4");

  it("starts as the frame's own (null) and takes any of the looks while choosing", () => {
    const s = choosing();
    expect(s.lookId).toBeNull();
    expect(run(s, { type: "SET_LOOK", lookId: "ink" }).lookId).toBe("ink");
    expect(
      run(s, { type: "SET_LOOK", lookId: "ink" }, { type: "SET_LOOK", lookId: "lamp" }).lookId,
    ).toBe("lamp");
  });

  it("takes 원본 (no look) back after a look", () => {
    const s = run(choosing(), { type: "SET_LOOK", lookId: "ink" });
    expect(run(s, { type: "SET_LOOK", lookId: "none" }).lookId).toBe("none");
  });

  it("refuses a look that does not exist", () => {
    const s = choosing();
    expect(run(s, { type: "SET_LOOK", lookId: "sparkle" })).toBe(s);
  });

  it("offers no look in a black-and-white or sepia frame: its tone is the concept", () => {
    const mono = toShotWith("film3");
    expect(mono.frameId).toBe("film3-mono-logo");
    expect(run(mono, { type: "SET_LOOK", lookId: "ink" })).toBe(mono);
    expect(run(mono, { type: "SET_LOOK", lookId: "none" })).toBe(mono);
    const sepia = toShotWith("film35", [{ type: "SET_OPTION", key: "color", value: "sepia" }]);
    expect(sepia.frameId).toBe("film35-sepia");
    expect(run(sepia, { type: "SET_LOOK", lookId: "lamp" })).toBe(sepia);
    // 35mm 필름's 컬러 is a colour frame: the guest chooses as everywhere else.
    const colour = toShotWith("film35");
    expect(colour.frameId).toBe("film35-natural");
    expect(run(colour, { type: "SET_LOOK", lookId: "lamp" }).lookId).toBe("lamp");
  });

  it("changes nothing else: the chosen photos stay chosen", () => {
    const s = run(choosing(), { type: "TOGGLE_SHOT_SELECTION", index: 2 });
    expect(s.selectedShotIndices).toEqual([0, 1, 3]);
    const changed = run(s, { type: "SET_LOOK", lookId: "pine" });
    expect(changed).toEqual({ ...s, lookId: "pine" });
  });

  it("is fixed with the photos: never before the choice screen, never after it", () => {
    // Shooting the last shot: not yet.
    let last = run(toReady(), { type: "BEGIN_SHOOTING", guide: false });
    for (let i = 0; i < SHOTS - 1; i++) last = shoot(last, `shot-${i}`);
    expect(run(last, { type: "SET_LOOK", lookId: "ink" })).toBe(last);
    const done = run(
      choosing(),
      { type: "SET_LOOK", lookId: "ink" },
      { type: "CONFIRM_SELECTION", askConsent: true },
    );
    expect([done.phase, done.lookId]).toEqual(["consent", "ink"]);
    expect(run(done, { type: "SET_LOOK", lookId: "lamp" })).toBe(done);
  });

  it("does not follow the guest into the next session", () => {
    const next = run(choosing(), { type: "SET_LOOK", lookId: "ink" }, { type: "RESET" });
    expect(next.lookId).toBeNull();
  });
});

describe("ordered selection", () => {
  // 필름 4컷: all four. The screen opens with 0, 1, 2, 3 chosen.
  const prepare = (cardId = "film4") => toShotWith(cardId);

  it("opens complete: one press finishes with the first photos, in shooting order", () => {
    const s = prepare();
    expect(s.selectedShotIndices).toEqual([0, 1, 2, 3]);
    const done = run(s, { type: "CONFIRM_SELECTION", askConsent: true });
    expect([done.phase, done.selectedShotIndices]).toEqual(["consent", [0, 1, 2, 3]]);
  });

  it("cannot confirm with a photo missing, and keeps the order the guest chooses in", () => {
    let s = cleared(prepare());
    expect(s.selectedShotIndices).toEqual([]);
    expect(run(s, { type: "CONFIRM_SELECTION", askConsent: true })).toBe(s);
    s = run(s, ...[3, 1, 2].map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const));
    expect(s.selectedShotIndices).toEqual([3, 1, 2]);
    expect(run(s, { type: "CONFIRM_SELECTION", askConsent: true })).toBe(s);
    s = run(
      s,
      { type: "TOGGLE_SHOT_SELECTION", index: 0 },
      { type: "CONFIRM_SELECTION", askConsent: true },
    );
    expect([s.phase, s.selectedShotIndices]).toEqual(["consent", [3, 1, 2, 0]]);
  });

  it("changing the order: take one out, put it back in (it goes last)", () => {
    const s = run(
      prepare(),
      { type: "TOGGLE_SHOT_SELECTION", index: 1 },
      { type: "TOGGLE_SHOT_SELECTION", index: 1 },
    );
    expect(s.selectedShotIndices).toEqual([0, 2, 3, 1]);
    expect(run(s, { type: "CONFIRM_SELECTION", askConsent: true }).phase).toBe("consent");
  });

  it("a full frame of several photos takes no extra one: nothing is dropped for the guest", () => {
    // A frame of three, with four shots: the fourth photo does not push one of the three out.
    const s = prepare("film3");
    expect(run(s, { type: "TOGGLE_SHOT_SELECTION", index: 3 })).toBe(s);
    let two = prepare("check2");
    expect(two.selectedShotIndices).toEqual([0, 1]);
    expect(run(two, { type: "TOGGLE_SHOT_SELECTION", index: 3 })).toBe(two);
    two = run(
      cleared(two),
      ...[2, 0, 3].map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const),
    );
    expect(two.selectedShotIndices).toEqual([2, 0]);
    expect(run(two, { type: "CONFIRM_SELECTION", askConsent: false }).phase).toBe("delivery");
    let three = cleared(prepare("film3"));
    three = run(
      three,
      ...[3, 2, 1, 0].map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const),
    );
    expect(three.selectedShotIndices).toEqual([3, 2, 1]);
    expect(run(three, { type: "CONFIRM_SELECTION", askConsent: true }).phase).toBe("consent");
  });

  it("a frame of one photo: tapping another photo swaps it in", () => {
    let one = prepare("polaroid1");
    expect(one.selectedShotIndices).toEqual([0]);
    one = run(one, { type: "TOGGLE_SHOT_SELECTION", index: 3 });
    expect(one.selectedShotIndices).toEqual([3]);
    one = run(one, { type: "TOGGLE_SHOT_SELECTION", index: 1 });
    expect(one.selectedShotIndices).toEqual([1]);
    // Tapping the chosen one takes it out; with none chosen the frame cannot be finished.
    const none = run(one, { type: "TOGGLE_SHOT_SELECTION", index: 1 });
    expect(none.selectedShotIndices).toEqual([]);
    expect(run(none, { type: "CONFIRM_SELECTION", askConsent: true })).toBe(none);
    expect(run(one, { type: "CONFIRM_SELECTION", askConsent: true }).phase).toBe("consent");
  });

  it("refuses a photo that does not exist", () => {
    const s = cleared(prepare());
    for (const index of [-1, SHOTS, 1.5, Number.NaN])
      expect(run(s, { type: "TOGGLE_SHOT_SELECTION", index })).toBe(s);
  });

  it("deselects; 이전 does nothing here: no way back to the camera or to a frame choice", () => {
    const s = run(
      prepare(),
      { type: "TOGGLE_SHOT_SELECTION", index: 2 },
      { type: "TOGGLE_SHOT_SELECTION", index: 2 },
      { type: "BACK" },
    );
    expect([s.phase, s.selectedShotIndices, s.delivery.status]).toEqual([
      "select",
      [0, 1, 3, 2],
      "idle",
    ]);
  });
});

describe("내 사진으로 참여하기 (D66) on the booth", () => {
  const READY = {
    type: "MOBILE_READY",
    sessionId: SESSION,
    url: "https://x/m/u1.a",
    expiresAt: "2026-12-24T10:15:00Z",
    via: "cloud",
  } as const;

  it("cover → QR → photo received", () => {
    let s = run(cover(), { type: "START_MOBILE" });
    expect([s.phase, s.mobile.status]).toEqual(["mobile", "loading"]);
    s = run(s, READY);
    expect(s.mobile).toMatchObject({ status: "ready", sessionId: SESSION });
    s = run(s, { type: "MOBILE_RECEIVED", sessionId: SESSION });
    expect(s.mobile.status).toBe("received");
    expect(run(s, { type: "RESET" })).toMatchObject({
      phase: "attract",
      mobile: { status: "idle" },
    });
  });

  it("a late answer about another QR changes nothing", () => {
    const s = run(cover(), { type: "START_MOBILE" }, READY);
    expect(s.mobile.status).toBe("ready");
    expect(run(s, { type: "MOBILE_RECEIVED", sessionId: "other" })).toBe(s);
  });

  it("failure reasons are kept for the screen; retry asks for a new QR", () => {
    let s = run(cover(), { type: "START_MOBILE" }, { type: "MOBILE_FAILED", reason: "offline" });
    expect(s.mobile).toEqual({ status: "failed", reason: "offline" });
    s = run(s, { type: "MOBILE_RETRY" });
    expect(s.mobile.status).toBe("loading");
  });

  it("only from the cover, and never touches the camera session", () => {
    for (const state of [init(), toReady(), toShot()])
      expect(run(state, { type: "START_MOBILE" })).toBe(state);
    const s = run(cover(), { type: "START_MOBILE" });
    expect(s.sessionId).toBe("");
    // And the cover's one touch does not start a camera session under a phone QR.
    expect(run(s, { type: "OPEN", sessionId: SESSION })).toBe(s);
    expect(progressStep("mobile", true)).toBeNull();
  });
});

describe("pose guide (D71): a choice on the ready screen, not a second flow", () => {
  const begin = (guide: boolean, s = toReady()) => run(s, { type: "BEGIN_SHOOTING", guide });

  it("is off by default and in free mode no pose is ever shown", () => {
    expect(init().poseGuide).toBe(false);
    let s = begin(false);
    expect(s.poseGuide).toBe(false);
    for (let i = 0; i < SHOTS; i++) {
      expect(currentPose(s)).toBeNull();
      s = shoot(s, `f-${i}`);
    }
    expect(s.phase).toBe("select");
  });

  it("guide mode shows the pose of the shot being counted down, four shots as always", () => {
    let s = begin(true);
    expect(currentPose(toReady())).toBeNull(); // not before shooting starts
    for (let i = 0; i < SHOTS; i++) {
      expect([s.phase, s.shotIndex]).toEqual(["countdown", i]);
      expect(currentPose(s)).toEqual(POSE_SEQUENCE[i]);
      s = run(s, ...ticks(s.remaining));
      expect(s.phase).toBe("capturing");
      expect(currentPose(s)).toEqual(POSE_SEQUENCE[i]);
      s = run(s, { type: "SHOT_CAPTURED", shot: `g-${i}` });
    }
    expect(s.phase).toBe("select");
    expect(capturedCount(s)).toBe(SHOTS);
    expect(currentPose(s)).toBeNull();
  });

  it("the guide changes nothing about the countdown", () => {
    expect(begin(true).remaining).toBe(begin(false).remaining);
    expect(currentPose(begin(true))).toEqual(POSE_SEQUENCE[0]);
  });

  it("the choice is asked again after a camera reconnect, and RESET clears it", () => {
    let s = begin(true);
    s = shoot(s, "a");
    s = run(s, { type: "CAMERA_FAILED", kind: "missing" }, { type: "CAMERA_RETRY" });
    s = run(s, { type: "CAMERA_READY" }, { type: "BEGIN_SHOOTING", guide: false });
    expect([s.shotIndex, s.poseGuide, currentPose(s)]).toEqual([1, false, null]);
    expect(run(begin(true), { type: "RESET" }).poseGuide).toBe(false);
  });

  it("a custom sequence is read by index (poses are data)", () => {
    const s = begin(true);
    expect(currentPose(s, [{ id: "x", label: "엑스" }])).toEqual({ id: "x", label: "엑스" });
    expect(currentPose(s, [])).toBeNull();
  });
});

describe("language (D78): a view, per guest", () => {
  it("starts in Korean, switches at any time, and the next guest starts in Korean again", () => {
    let s = init();
    expect(s.lang).toBe("ko");
    s = run(s, { type: "SET_LANG", lang: "en" });
    expect(s.lang).toBe("en");
    s = run(s, { type: "SET_LANG", lang: "ko" });
    expect([s.phase, s.lang]).toEqual(["pick", "ko"]);
    s = run(s, { type: "SET_LANG", lang: "en" }, { type: "RESET" });
    expect(s.lang).toBe("ko");
  });

  it("changes nothing else: the same shots, frames and steps in both languages", () => {
    const ko = toShot();
    const en = run(init(), { type: "SET_LANG", lang: "en" });
    let s = run(
      en,
      { type: "CONFIRM_PICK", random: 0 },
      { type: "CONFIRM_OPTIONS", random: 0 },
      { type: "CAMERA_READY" },
    );
    s = run(s, { type: "BEGIN_SHOOTING", guide: false });
    for (let i = 0; i < SHOTS; i++) s = shoot(s, `shot-${i}`);
    expect({ ...s, lang: "ko" }).toEqual(ko);
  });

  it("every English and Chinese string exists for every Korean one", () => {
    const shape = (o: unknown): unknown =>
      typeof o === "function"
        ? `fn${(o as (...a: unknown[]) => unknown).length}`
        : Array.isArray(o)
          ? o.map(shape)
          : o && typeof o === "object"
            ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)]))
            : typeof o;
    expect(shape(KIOSK_COPY.en)).toEqual(shape(KIOSK_COPY.ko));
    expect(shape(KIOSK_COPY.zh)).toEqual(shape(KIOSK_COPY.ko));
    const hangul = /[\uac00-\ud7a3]/;
    const strings = (o: unknown, path = ""): [string, string][] =>
      typeof o === "string"
        ? [[path, o]]
        : typeof o === "function"
          ? [[path, String((o as (...a: number[]) => string)(1, 2))]]
          : o && typeof o === "object"
            ? Object.entries(o).flatMap(([k, v]) => strings(v, `${path}.${k}`))
            : [];
    // A polaroid caption is shown as it is written on the photo, in every language (「메리
    // 크리스마스」 stays Korean on an English screen); only the two that describe it are translated.
    const captions = [...POLAROID1_CAPTIONS, ...POLAROID1_RETIRED_CAPTIONS]
      .filter((c) => c !== "date" && c !== "circle")
      .map((c) => `.value.${c}`);
    // Korean only where it names something Korean on purpose: the language picker's own label.
    const allowed = new Set([".langGroup", ...captions]);
    for (const [path, text] of strings(KIOSK_COPY.en))
      if (!allowed.has(path)) expect(hangul.test(text), `${path}: ${text}`).toBe(false);
    // The Chinese screens are Chinese, not English: every string has Han characters, except
    // where it names something on purpose (the event name, the language picker's label).
    const han = /\p{Script=Han}/u;
    const notChinese = new Set([".attract.event", ".langGroup", ...captions]);
    for (const [path, text] of strings(KIOSK_COPY.zh))
      if (!notChinese.has(path)) {
        expect(han.test(text), `${path}: ${text}`).toBe(true);
        // No Korean either.
        expect(hangul.test(text), `${path}: ${text}`).toBe(false);
      }
  });
});

describe("back (D78): one step, never losing what the guest made", () => {
  it("frame pick → the cover, and the session is gone (the language chosen there is kept)", () => {
    const s = run(cover(), { type: "SET_LANG", lang: "en" }, { type: "OPEN", sessionId: SESSION });
    expect(canGoBack(s)).toBe(true);
    const back = run(s, { type: "BACK" });
    expect([back.phase, back.sessionId, back.lang]).toEqual(["attract", "", "en"]);
    // The next touch is a new session.
    expect(run(back, { type: "OPEN", sessionId: "next" }).sessionId).toBe("next");
  });

  it("camera before the first shot → the options (the font is drawn again on the way back in)", () => {
    const s = toReady();
    expect(canGoBack(s)).toBe(true);
    expect(run(s, { type: "BACK" }).phase).toBe("options");
  });

  it("not once a shot exists, not while shooting, not after the frame is final", () => {
    let s = run(toReady(), { type: "BEGIN_SHOOTING", guide: false });
    expect(canGoBack(s)).toBe(false);
    expect(run(s, { type: "BACK" })).toBe(s);
    s = shoot(s, "shot-0");
    // A reconnect brings the guest back to the camera with one shot kept.
    const reconnected = run(
      s,
      { type: "CAMERA_FAILED", kind: "missing" },
      { type: "CAMERA_RETRY" },
      { type: "CAMERA_READY" },
    );
    expect([reconnected.phase, canGoBack(reconnected)]).toEqual(["ready", false]);
    const select = toShot();
    expect(canGoBack(select)).toBe(false);
    const consent = selectAll(select, true);
    expect(consent.phase).toBe("consent");
    expect(canGoBack(consent)).toBe(false);
    expect(run(consent, { type: "BACK" })).toBe(consent);
  });

  it("the photo choice goes back nowhere (2026-11-27: the frame is fixed, the shots are taken)", () => {
    const select = run(toShot(), { type: "TOGGLE_SHOT_SELECTION", index: 2 });
    expect(canGoBack(select)).toBe(false);
    expect(run(select, { type: "BACK" })).toBe(select);
  });
});

describe("attract screen (D80): 화면을 눌러 시작", () => {
  const fresh = () => attractState<string>({ shotCount: SHOTS, countdownSeconds: 3 });

  it("the booth starts on the cover; one touch starts a session at the frame picker (2026-11-27)", () => {
    const s = fresh();
    expect([s.phase, s.sessionId]).toEqual(["attract", ""]);
    const open = run(s, { type: "OPEN", sessionId: SESSION });
    expect([open.phase, open.sessionId, open.cardId]).toEqual(["pick", SESSION, "film3"]);
    // A second touch (a double tap) does not start again or move on.
    expect(run(open, { type: "OPEN", sessionId: "again" })).toBe(open);
    // The old two-step start is gone: its action changes nothing anywhere.
    expect(run(s, { type: "START", sessionId: SESSION } as never)).toBe(s);
    expect(run(open, { type: "START", sessionId: "x" } as never)).toBe(open);
  });

  it("the cover's own controls: the language, and the way to the phone QR", () => {
    const s = fresh();
    expect(run(s, { type: "SET_LANG", lang: "zh" })).toMatchObject({
      phase: "attract",
      lang: "zh",
    });
    expect(run(s, { type: "START_MOBILE" })).toMatchObject({
      phase: "mobile",
      mobile: { status: "loading" },
      sessionId: "",
    });
    // A language left on the cover does not wait for the next guest: RESET is Korean again.
    expect(run(s, { type: "SET_LANG", lang: "zh" }, { type: "RESET" }).lang).toBe("ko");
  });

  it("the shortest way through a session is six touches", () => {
    // Each line is one touch; the shots themselves need none.
    const touches: KioskAction<string>[] = [
      { type: "OPEN", sessionId: SESSION }, // 1 · 화면을 눌러 시작
      { type: "PICK_CARD", cardId: "film3", random: 0 }, // 2 · a frame
      { type: "CONFIRM_OPTIONS", random: 0 }, // 3 · 이대로 찍기
      { type: "BEGIN_SHOOTING", guide: false }, // 4 · 자유 포즈로 찍기
      { type: "CONFIRM_SELECTION", askConsent: true }, // 5 · 이 사진으로 완성하기
      { type: "SET_CONSENT", consent: "no" }, // 6 · the wall answer
    ];
    let state = fresh();
    for (const touch of touches) {
      const before = state;
      // What the booth does by itself between touches: the camera coming on, the five shots.
      if (touch.type === "BEGIN_SHOOTING") state = run(state, { type: "CAMERA_READY" });
      state = run(state, touch);
      expect(state, touch.type).not.toBe(before);
      if (touch.type === "BEGIN_SHOOTING")
        for (let i = 0; i < SHOTS; i++) state = shoot(state, `shot-${i}`);
    }
    expect(state.phase).toBe("delivery");
    expect(touches).toHaveLength(6);
    // The cards without options (five touches) were all taken down on 2026-11-27: every card
    // offered today has an options screen, so six is the shortest way.
    expect(OFFERED_CARDS.every((c) => c.options.length > 0)).toBe(true);
  });

  it("has no step, no back and no progress", () => {
    expect(canGoBack(fresh())).toBe(false);
    expect(progressStep("attract", true)).toBeNull();
  });

  it("the attract copy exists in all three languages", () => {
    expect(KIOSK_COPY.ko.attract.start).toBe("화면을 눌러 시작");
    expect(KIOSK_COPY.en.attract.start).not.toMatch(/[가-힣]/);
    expect(KIOSK_COPY.zh.attract.start).toMatch(/\p{Script=Han}/u);
  });
});
