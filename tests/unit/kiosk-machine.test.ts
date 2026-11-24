import { describe, expect, it } from "vitest";
import { POSE_SEQUENCE } from "@/config/poses";
import { getFrame } from "@/config/frames";
import { HAND_FONTS } from "@/config/hand-fonts";
import { KIOSK_COPY } from "@/lib/kiosk/copy";
import {
  MAX_CAPTURE_FAILURES,
  canGoBack,
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

/** Most tests start where a guest has touched the attract screen (D80). */
function createInitialState<Shot>(init: Parameters<typeof attractState>[0]): KioskState<Shot> {
  return kioskReducer(attractState<Shot>(init), { type: "OPEN" });
}
const SESSION = "11111111-2222-4333-8444-555555555555";

function init(): S {
  return createInitialState<string>({ shotCount: 6, countdownSeconds: 3 });
}

function run(state: S, ...actions: KioskAction<string>[]): S {
  return actions.reduce(kioskReducer<string>, state);
}

/** 필름 3컷 (the default card) → its options → the camera. */
const toReady = (s = init()) =>
  run(
    s,
    { type: "START", sessionId: SESSION },
    { type: "CONFIRM_PICK", random: 0 },
    { type: "CONFIRM_OPTIONS", random: 0 },
    { type: "CAMERA_READY" },
  );
const ticks = (n: number) => Array.from({ length: n }, () => ({ type: "TICK" }) as const);

/** Count down and capture one shot. */
const shoot = (s: S, label: string) =>
  run(s, ...ticks(s.remaining), { type: "SHOT_CAPTURED", shot: label });

function shootSix(ready: S): S {
  let s = run(ready, { type: "BEGIN_SHOOTING", guide: false });
  for (let i = 0; i < 6; i++) s = shoot(s, `shot-${i}`);
  return s;
}
const toReview = (): S => shootSix(toReady());

/** A card (and its options) on the picker, then the camera and six shots. */
function toReviewWith(cardId: string, options: KioskAction<string>[] = []): S {
  let s = run(init(), { type: "START", sessionId: SESSION }, { type: "SELECT_CARD", cardId });
  s = run(s, { type: "CONFIRM_PICK", random: 0 });
  if (s.phase === "options") s = run(s, ...options, { type: "CONFIRM_OPTIONS", random: 0 });
  return shootSix(run(s, { type: "CAMERA_READY" }));
}

/** Review → choose as many photos as the frame holds → the wall question (or the QR). */
const selectAll = (review: S, askConsent: boolean) => {
  const s = run(review, { type: "CONFIRM_SHOTS" });
  const n = getFrame(s.frameId).slots.length;
  return run(
    s,
    ...Array.from({ length: n }, (_, index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const),
    { type: "CONFIRM_SELECTION", askConsent },
  );
};

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

describe("exactly six captures", () => {
  it("goes to review after the sixth shot, in order", () => {
    const s = toReview();
    expect(s.phase).toBe("review");
    expect(s.shots).toEqual(["shot-0", "shot-1", "shot-2", "shot-3", "shot-4", "shot-5"]);
    expect(capturedCount(s)).toBe(6);
  });

  it("rejects a stray seventh frame", () => {
    const s = toReview();
    expect(run(s, { type: "SHOT_CAPTURED", shot: "extra" })).toBe(s);
  });

  it("does not accept a shot while still counting down", () => {
    const s = run(toReady(), { type: "BEGIN_SHOOTING", guide: false });
    expect(run(s, { type: "SHOT_CAPTURED", shot: "early" })).toBe(s);
  });

  it("only confirms when all six exist, straight to choosing the photos", () => {
    const s = toReview();
    expect(run(s, { type: "CONFIRM_SHOTS" }).phase).toBe("select");
    const five = run(toReady(), { type: "BEGIN_SHOOTING", guide: false });
    let partial = five;
    for (let i = 0; i < 5; i++) partial = shoot(partial, `p-${i}`);
    expect(run(partial, { type: "CONFIRM_SHOTS" })).toBe(partial);
  });
});

describe("no extra photo, no second frame choice (v2)", () => {
  it("has no seventh slot: the review holds exactly six and an unknown action changes nothing", () => {
    const six = toReview();
    expect(six.shots).toHaveLength(6);
    expect("extraShotPending" in six).toBe(false);
    for (const type of ["TAKE_EXTRA_SHOT", "BACK_TO_FRAME", "CONFIRM_FRAME", "SELECT_FRAME"])
      expect(run(six, { type } as never)).toBe(six);
  });

  it("after shooting the card, colour and logo cannot change", () => {
    const select = run(toReview(), { type: "CONFIRM_SHOTS" });
    const frameId = select.frameId;
    const s = run(
      select,
      { type: "SELECT_CARD", cardId: "lace1" },
      { type: "SET_OPTION", key: "color", value: "sepia" },
      { type: "BACK" },
    );
    expect([s.phase, s.frameId]).toEqual(["select", frameId]);
    expect(canGoBack(select)).toBe(false);
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

describe("틀 선택 v2: seven cards, options before shooting", () => {
  it("starts on 필름 3컷 with its defaults (흑백, 로고 넣기)", () => {
    const s = run(init(), { type: "START", sessionId: SESSION });
    expect([s.phase, s.cardId, s.frameId]).toEqual(["pick", "film3", "film3-mono-logo"]);
    expect(s.frameOptions).toEqual({ color: "mono", logo: "logoOn" });
  });

  it("a card with options goes to the options screen; one without goes straight to the camera", () => {
    const pick = run(init(), { type: "START", sessionId: SESSION });
    for (const id of ["film3", "film4", "check2"])
      expect(
        run(pick, { type: "SELECT_CARD", cardId: id }, { type: "CONFIRM_PICK", random: 0 }).phase,
      ).toBe("options");
    for (const id of ["polaroid1", "polaroid3", "verse4", "lace1"])
      expect(
        run(pick, { type: "SELECT_CARD", cardId: id }, { type: "CONFIRM_PICK", random: 0 }).phase,
      ).toBe("camera");
  });

  it("every option combination is its own frame", () => {
    const at = (cardId: string, ...opts: KioskAction<string>[]) =>
      run(
        init(),
        { type: "START", sessionId: SESSION },
        { type: "SELECT_CARD", cardId },
        { type: "CONFIRM_PICK", random: 0 },
        ...opts,
      ).frameId;
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
    let s = run(init(), { type: "START", sessionId: SESSION }, { type: "CONFIRM_PICK", random: 0 });
    expect(s.phase).toBe("options");
    expect(run(s, { type: "BACK" }).phase).toBe("pick");
    s = run(s, { type: "CONFIRM_OPTIONS", random: 0 }, { type: "CAMERA_READY" });
    expect(run(s, { type: "BACK" }).phase).toBe("options");
    const lace = run(
      init(),
      { type: "START", sessionId: SESSION },
      { type: "SELECT_CARD", cardId: "lace1" },
      { type: "CONFIRM_PICK", random: 0 },
      { type: "CAMERA_READY" },
    );
    expect(run(lace, { type: "BACK" }).phase).toBe("pick");
    const shot = shoot(run(lace, { type: "BEGIN_SHOOTING", guide: false }), "a");
    expect(canGoBack(shot)).toBe(false);
  });

  it("does not start the camera or change the frame from other screens", () => {
    const welcome = init();
    expect(run(welcome, { type: "CONFIRM_PICK", random: 0 })).toBe(welcome);
    expect(run(welcome, { type: "CONFIRM_OPTIONS", random: 0 })).toBe(welcome);
    const review = toReview();
    expect(run(review, { type: "SELECT_CARD", cardId: "lace1" })).toBe(review);
  });

  it("asks the wall question unless submissions are paused", () => {
    expect(run(toReview(), { type: "CONFIRM_SHOTS" }).phase).toBe("select");
    expect(selectAll(toReview(), true).phase).toBe("consent");
    expect(selectAll(toReview(), false).phase).toBe("delivery");
  });
});

describe("handwriting font (film 4컷, polaroid 1컷)", () => {
  const lockAt = (s: S, cardId: string, random: number) => {
    let next = run(s, { type: "START", sessionId: SESSION }, { type: "SELECT_CARD", cardId });
    next = run(next, { type: "CONFIRM_PICK", random });
    if (next.phase === "options") next = run(next, { type: "CONFIRM_OPTIONS", random });
    return next;
  };

  it("is drawn when shooting starts, only for frames that carry handwriting", () => {
    expect(lockAt(init(), "film4", 0).handFont).toBe(HAND_FONTS[0]!.id);
    expect(lockAt(init(), "polaroid1", 0.99).handFont).toBe(HAND_FONTS[9]!.id);
    expect(lockAt(init(), "film3", 0).handFont).toBeNull();
    expect(lockAt(init(), "lace1", 0).handFont).toBeNull();
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
      s = run(s, { type: "RESET" }, { type: "OPEN" });
    }
    expect(repeats).toBe(0);
    expect(seen.size).toBeGreaterThan(1);
  });

  it("is kept across a reload through the initial state", () => {
    const s = createInitialState<string>({
      shotCount: 6,
      countdownSeconds: 3,
      lastHandFont: HAND_FONTS[0]!.id,
    });
    expect(lockAt(s, "film4", 0).handFont).not.toBe(HAND_FONTS[0]!.id);
    const unknown = createInitialState<string>({
      shotCount: 6,
      countdownSeconds: 3,
      lastHandFont: "x",
    });
    expect(unknown.lastHandFont).toBeNull();
  });
});

describe("delivery and consent are independent", () => {
  const toConsent = () => selectAll(toReview(), true);
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
    const select = run(toReview(), { type: "CONFIRM_SHOTS" });
    expect(run(select, ready)).toBe(select);
    expect(run(select, { type: "DELIVERY_STARTED" })).toBe(select);
  });
});

describe("progress", () => {
  it("six steps (틀 → 촬영 → 확인 → 사진 고르기 → 동의 → QR), five while submissions are paused", () => {
    expect(progressStep("welcome", true)).toBeNull();
    expect(progressStep("pick", true)).toEqual({ step: 1, total: 6 });
    expect(progressStep("options", true)).toEqual({ step: 1, total: 6 });
    expect(progressStep("countdown", true)).toEqual({ step: 2, total: 6 });
    expect(progressStep("review", true)).toEqual({ step: 3, total: 6 });
    expect(progressStep("select", true)).toEqual({ step: 4, total: 6 });
    expect(progressStep("consent", true)).toEqual({ step: 5, total: 6 });
    expect(progressStep("delivery", true)).toEqual({ step: 6, total: 6 });
    expect(progressStep("delivery", false)).toEqual({ step: 5, total: 5 });
  });

  it("the dots follow what this session really does: fixed once the photos are chosen", () => {
    // Before that, it is what would happen now (the staff switch as the booth last heard it).
    const before = toReviewWith("lace1");
    expect(before.consentAsked).toBeNull();
    expect(sessionAsksConsent(before, true)).toBe(true);
    expect(sessionAsksConsent(before, false)).toBe(false);

    const chosen = run(
      before,
      { type: "CONFIRM_SHOTS" },
      { type: "TOGGLE_SHOT_SELECTION", index: 0 },
    );
    // Asked: six dots to the end, even if staff pause submissions while the guest answers.
    const asked = run(chosen, { type: "CONFIRM_SELECTION", askConsent: true });
    expect([asked.phase, asked.consentAsked]).toEqual(["consent", true]);
    expect(progressStep(asked.phase, sessionAsksConsent(asked, false))).toEqual({
      step: 5,
      total: 6,
    });
    const answered = run(asked, { type: "SET_CONSENT", consent: "no" });
    expect(progressStep(answered.phase, sessionAsksConsent(answered, false))).toEqual({
      step: 6,
      total: 6,
    });
    // Skipped: five dots to the end, even if staff open submissions again on the QR screen.
    const skipped = run(chosen, { type: "CONFIRM_SELECTION", askConsent: false });
    expect([skipped.phase, skipped.consentAsked]).toEqual(["delivery", false]);
    expect(progressStep(skipped.phase, sessionAsksConsent(skipped, true))).toEqual({
      step: 5,
      total: 5,
    });
    // The next guest starts undecided again.
    expect(run(skipped, { type: "RESET" }).consentAsked).toBeNull();
  });
});

describe("reset", () => {
  it("clears the previous session entirely", () => {
    const done = run(
      selectAll(toReviewWith("film4", [{ type: "SET_OPTION", key: "color", value: "red" }]), true),
      { type: "DELIVERY_SUCCEEDED", token: "t", url: "u", expiresAt: "e" },
      { type: "SET_CONSENT", consent: "yes" },
    );
    expect(done.frameId).toBe("film4-red");
    const s = run(done, { type: "RESET" });
    expect(s.phase).toBe("attract");
    expect(s.sessionId).toBe("");
    expect(s.shots).toEqual([null, null, null, null, null, null]);
    expect(s.delivery).toEqual({ status: "idle" });
    expect(s.consent).toBeNull();
    // Every guest starts on 필름 3컷 (v2); only the font is remembered, so the next one differs.
    expect([s.cardId, s.frameId, s.handFont]).toEqual(["film3", "film3-mono-logo", null]);
    expect(s.lastHandFont).toBe(done.handFont);
  });

  it("each START begins a new session id", () => {
    const a = run(init(), { type: "START", sessionId: "a" });
    const b = run(a, { type: "RESET" }, { type: "OPEN" }, { type: "START", sessionId: "b" });
    expect([a.sessionId, b.sessionId]).toEqual(["a", "b"]);
  });
});

describe("the colour look a guest chooses with the photos", () => {
  const choosing = () => run(toReviewWith("verse4"), { type: "CONFIRM_SHOTS" });

  it("starts as the frame's own (null) and takes any of the looks while choosing", () => {
    const s = choosing();
    expect(s.lookId).toBeNull();
    expect(run(s, { type: "SET_LOOK", lookId: "ink" }).lookId).toBe("ink");
    expect(
      run(s, { type: "SET_LOOK", lookId: "ink" }, { type: "SET_LOOK", lookId: "lamp" }).lookId,
    ).toBe("lamp");
  });

  it("refuses a look that does not exist", () => {
    const s = choosing();
    expect(run(s, { type: "SET_LOOK", lookId: "sparkle" })).toBe(s);
  });

  it("changes nothing else: the chosen photos stay chosen", () => {
    const s = run(choosing(), { type: "TOGGLE_SHOT_SELECTION", index: 2 });
    const changed = run(s, { type: "SET_LOOK", lookId: "pine" });
    expect(changed).toEqual({ ...s, lookId: "pine" });
  });

  it("is fixed with the photos: never before the choice screen, never after it", () => {
    const review = toReviewWith("verse4");
    expect(run(review, { type: "SET_LOOK", lookId: "ink" })).toBe(review);
    const done = run(
      choosing(),
      { type: "SET_LOOK", lookId: "ink" },
      ...[0, 1, 2, 3].map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const),
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
  const prepare = (cardId = "verse4") => run(toReviewWith(cardId), { type: "CONFIRM_SHOTS" });
  it("cannot confirm early and preserves selection order", () => {
    let s = prepare();
    expect(run(s, { type: "CONFIRM_SELECTION", askConsent: true })).toBe(s);
    s = run(s, ...[5, 1, 3].map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const));
    expect(s.selectedShotIndices).toEqual([5, 1, 3]);
    expect(run(s, { type: "CONFIRM_SELECTION", askConsent: true })).toBe(s);
    s = run(
      s,
      { type: "TOGGLE_SHOT_SELECTION", index: 0 },
      { type: "CONFIRM_SELECTION", askConsent: true },
    );
    expect([s.phase, s.selectedShotIndices]).toEqual(["consent", [5, 1, 3, 0]]);
  });
  it("accepts a 1-slot, a 2-slot or a 3-slot frame and prevents overflow", () => {
    let one = prepare("lace1");
    one = run(one, ...[3, 1].map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const));
    expect(one.selectedShotIndices).toEqual([3]);
    expect(run(one, { type: "CONFIRM_SELECTION", askConsent: true }).phase).toBe("consent");
    let two = prepare("check2");
    two = run(
      two,
      ...[2, 4, 5].map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const),
    );
    expect(two.selectedShotIndices).toEqual([2, 4]);
    expect(run(two, { type: "CONFIRM_SELECTION", askConsent: false }).phase).toBe("delivery");
    let three = prepare("polaroid3");
    three = run(
      three,
      ...[5, 4, 3, 2].map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const),
    );
    expect(three.selectedShotIndices).toEqual([5, 4, 3]);
    expect(run(three, { type: "CONFIRM_SELECTION", askConsent: true }).phase).toBe("consent");
  });
  it("deselects; there is no way back to a frame choice", () => {
    const s = run(
      prepare(),
      { type: "TOGGLE_SHOT_SELECTION", index: 2 },
      { type: "TOGGLE_SHOT_SELECTION", index: 2 },
      { type: "BACK" },
    );
    expect([s.phase, s.selectedShotIndices, s.delivery.status]).toEqual(["select", [], "idle"]);
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

  it("welcome → QR → photo received", () => {
    let s = run(init(), { type: "START_MOBILE" });
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
    const s = run(init(), { type: "START_MOBILE" }, READY);
    expect(run(s, { type: "MOBILE_RECEIVED", sessionId: "other" })).toBe(s);
  });

  it("failure reasons are kept for the screen; retry asks for a new QR", () => {
    let s = run(init(), { type: "START_MOBILE" }, { type: "MOBILE_FAILED", reason: "offline" });
    expect(s.mobile).toEqual({ status: "failed", reason: "offline" });
    s = run(s, { type: "MOBILE_RETRY" });
    expect(s.mobile.status).toBe("loading");
  });

  it("only from the welcome screen, and never touches the camera session", () => {
    const ready = toReady();
    expect(run(ready, { type: "START_MOBILE" })).toBe(ready);
    const s = run(init(), { type: "START_MOBILE" });
    expect(s.sessionId).toBe("");
    expect(progressStep("mobile", true)).toBeNull();
  });
});

describe("pose guide (D71): a choice on the ready screen, not a second flow", () => {
  const begin = (guide: boolean, s = toReady()) => run(s, { type: "BEGIN_SHOOTING", guide });

  it("is off by default and in free mode no pose is ever shown", () => {
    expect(init().poseGuide).toBe(false);
    let s = begin(false);
    expect(s.poseGuide).toBe(false);
    for (let i = 0; i < 6; i++) {
      expect(currentPose(s)).toBeNull();
      s = shoot(s, `f-${i}`);
    }
    expect(s.phase).toBe("review");
  });

  it("guide mode shows the pose of the shot being counted down, six shots as always", () => {
    let s = begin(true);
    expect(currentPose(toReady())).toBeNull(); // not before shooting starts
    for (let i = 0; i < 6; i++) {
      expect([s.phase, s.shotIndex]).toEqual(["countdown", i]);
      expect(currentPose(s)).toEqual(POSE_SEQUENCE[i]);
      s = run(s, ...ticks(s.remaining));
      expect(s.phase).toBe("capturing");
      expect(currentPose(s)).toEqual(POSE_SEQUENCE[i]);
      s = run(s, { type: "SHOT_CAPTURED", shot: `g-${i}` });
    }
    expect(s.phase).toBe("review");
    expect(capturedCount(s)).toBe(6);
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
    s = run(s, { type: "START", sessionId: SESSION }, { type: "SET_LANG", lang: "ko" });
    expect([s.phase, s.lang]).toEqual(["pick", "ko"]);
    s = run(s, { type: "SET_LANG", lang: "en" }, { type: "RESET" });
    expect(s.lang).toBe("ko");
  });

  it("changes nothing else: the same shots, frames and steps in both languages", () => {
    const ko = toReview();
    const en = run(init(), { type: "SET_LANG", lang: "en" });
    let s = run(
      en,
      { type: "START", sessionId: SESSION },
      { type: "CONFIRM_PICK", random: 0 },
      { type: "CONFIRM_OPTIONS", random: 0 },
      { type: "CAMERA_READY" },
    );
    s = run(s, { type: "BEGIN_SHOOTING", guide: false });
    for (let i = 0; i < 6; i++) s = shoot(s, `shot-${i}`);
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
    // Korean only where it names something Korean on purpose: the language picker's own label.
    const allowed = new Set([".langGroup"]);
    for (const [path, text] of strings(KIOSK_COPY.en))
      if (!allowed.has(path)) expect(hangul.test(text), `${path}: ${text}`).toBe(false);
    // The Chinese screens are Chinese, not English: every string has Han characters, except
    // where it names something on purpose (the event name, the language picker's label).
    const han = /\p{Script=Han}/u;
    const notChinese = new Set([".attract.event", ".langGroup"]);
    for (const [path, text] of strings(KIOSK_COPY.zh))
      if (!notChinese.has(path)) {
        expect(han.test(text), `${path}: ${text}`).toBe(true);
        // No Korean either.
        expect(hangul.test(text), `${path}: ${text}`).toBe(false);
      }
  });
});

describe("back (D78): one step, never losing what the guest made", () => {
  it("frame pick → welcome, and the session is gone", () => {
    const s = run(init(), { type: "START", sessionId: SESSION });
    expect(canGoBack(s)).toBe(true);
    const back = run(s, { type: "BACK" });
    expect([back.phase, back.sessionId]).toEqual(["welcome", ""]);
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
    const review = toReview();
    expect(canGoBack(review)).toBe(false);
    const select = run(review, { type: "CONFIRM_SHOTS" });
    expect(canGoBack(select)).toBe(false);
    const consent = selectAll(review, true);
    expect(consent.phase).toBe("consent");
    expect(canGoBack(consent)).toBe(false);
    expect(run(consent, { type: "BACK" })).toBe(consent);
  });

  it("photo selection has no way back (v2: the frame is fixed once shooting starts)", () => {
    const select = run(
      toReview(),
      { type: "CONFIRM_SHOTS" },
      { type: "TOGGLE_SHOT_SELECTION", index: 2 },
    );
    expect(canGoBack(select)).toBe(false);
    expect(run(select, { type: "BACK" })).toBe(select);
  });
});

describe("attract screen (D80): 화면을 눌러 시작", () => {
  const fresh = () => attractState<string>({ shotCount: 6, countdownSeconds: 3 });

  it("the booth starts on the attract screen, and only a touch opens the welcome choices", () => {
    const s = fresh();
    expect([s.phase, s.sessionId]).toEqual(["attract", ""]);
    // Nothing starts from the attract screen except OPEN.
    expect(run(s, { type: "START", sessionId: SESSION }).phase).toBe("attract");
    expect(run(s, { type: "START_MOBILE" }).phase).toBe("attract");
    expect(run(s, { type: "OPEN" }).phase).toBe("welcome");
    expect(run(s, { type: "OPEN" }, { type: "OPEN" }).phase).toBe("welcome");
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
