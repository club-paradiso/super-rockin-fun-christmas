import { describe, expect, it } from "vitest";
import {
  MAX_CAPTURE_FAILURES,
  capturedCount,
  createInitialState,
  kioskReducer,
  progressStep,
  type KioskAction,
  type KioskState,
} from "@/lib/kiosk/machine";

type S = KioskState<string>;
const SESSION = "11111111-2222-4333-8444-555555555555";

function init(): S {
  return createInitialState<string>({
    shotCount: 6,
    countdownSeconds: 3,
    frameId: "navy-strip",
  });
}

function run(state: S, ...actions: KioskAction<string>[]): S {
  return actions.reduce(kioskReducer<string>, state);
}

const toReady = (s = init()) =>
  run(s, { type: "START", sessionId: SESSION }, { type: "CONFIRM_PICK" }, { type: "CAMERA_READY" });
const ticks = (n: number) => Array.from({ length: n }, () => ({ type: "TICK" }) as const);

/** Count down and capture one shot. */
const shoot = (s: S, label: string) =>
  run(s, ...ticks(s.remaining), { type: "SHOT_CAPTURED", shot: label });

function toReview(): S {
  let s = run(toReady(), { type: "BEGIN_SHOOTING" });
  for (let i = 0; i < 6; i++) s = shoot(s, `shot-${i}`);
  return s;
}

const selectFour = (frame: S, askConsent: boolean) =>
  run(frame, { type: "CONFIRM_FRAME", askConsent }, ...[0, 1, 2, 3].map(
    (index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const,
  ), { type: "CONFIRM_SELECTION", askConsent });

describe("countdown", () => {
  it("counts 3 → 2 → 1 → capturing", () => {
    let s = run(toReady(), { type: "BEGIN_SHOOTING" });
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
    let s = run(toReady(), { type: "BEGIN_SHOOTING" });
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
    const s = run(toReady(), { type: "BEGIN_SHOOTING" });
    expect(run(s, { type: "SHOT_CAPTURED", shot: "early" })).toBe(s);
  });

  it("only confirms when all six exist", () => {
    const s = toReview();
    expect(run(s, { type: "CONFIRM_SHOTS" }).phase).toBe("frame");
  });
});

describe("retake", () => {
  it("retakes a single shot and returns to review", () => {
    let s = run(toReview(), { type: "RETAKE", index: 2 });
    expect([s.phase, s.shotIndex, s.retakeIndex]).toEqual(["countdown", 2, 2]);
    s = shoot(s, "new-2");
    expect(s.phase).toBe("review");
    expect(s.shots).toEqual(["shot-0", "shot-1", "new-2", "shot-3", "shot-4", "shot-5"]);
    expect(s.retakeIndex).toBeNull();
  });

  it("retake all clears every shot and starts from the first", () => {
    const s = run(toReview(), { type: "RETAKE_ALL" });
    expect(s.shots).toEqual([null, null, null, null, null, null]);
    expect([s.phase, s.shotIndex]).toEqual(["countdown", 0]);
  });

  it("ignores out-of-range retakes", () => {
    const s = toReview();
    expect(run(s, { type: "RETAKE", index: 6 })).toBe(s);
  });
});

describe("failures", () => {
  it("retries a failed capture, then gives up to the camera error screen", () => {
    let s = run(toReady(), { type: "BEGIN_SHOOTING" }, ...ticks(3));
    s = run(s, { type: "CAPTURE_FAILED" });
    expect([s.phase, s.shotIndex]).toEqual(["countdown", 0]);
    for (let i = 1; i < MAX_CAPTURE_FAILURES; i++)
      s = run(s, ...ticks(3), { type: "CAPTURE_FAILED" });
    expect([s.phase, s.cameraError]).toEqual(["camera-error", "failed"]);
  });

  it("keeps earlier shots across a camera reconnect", () => {
    let s = run(toReady(), { type: "BEGIN_SHOOTING" });
    s = shoot(s, "a");
    s = shoot(s, "b");
    s = run(s, { type: "CAMERA_FAILED", kind: "missing" });
    expect(s.phase).toBe("camera-error");
    s = run(s, { type: "CAMERA_RETRY" }, { type: "CAMERA_READY" }, { type: "BEGIN_SHOOTING" });
    expect([s.phase, s.shotIndex]).toEqual(["countdown", 2]);
    expect(s.shots.slice(0, 2)).toEqual(["a", "b"]);
  });
});

describe("frame first, then again with the photos", () => {
  it("start → pick a frame → camera; the choice is preselected after shooting", () => {
    let s = run(init(), { type: "START", sessionId: SESSION });
    expect(s.phase).toBe("pick");
    s = run(s, { type: "SELECT_FRAME", frameId: "clothesline" }, { type: "CONFIRM_PICK" });
    expect([s.phase, s.frameId]).toEqual(["camera", "clothesline"]);
    s = run(s, { type: "CAMERA_READY" }, { type: "BEGIN_SHOOTING" });
    for (let i = 0; i < 6; i++) s = shoot(s, `shot-${i}`);
    s = run(s, { type: "CONFIRM_SHOTS" });
    expect([s.phase, s.frameId]).toEqual(["frame", "clothesline"]);
    s = run(s, { type: "SELECT_FRAME", frameId: "cream-strip" });
    expect(s.frameId).toBe("cream-strip");
  });

  it("does not start the camera or change the frame from other screens", () => {
    const welcome = init();
    expect(run(welcome, { type: "CONFIRM_PICK" })).toBe(welcome);
    const review = toReview();
    expect(run(review, { type: "SELECT_FRAME", frameId: "x" })).toBe(review);
  });

  it("asks the wall question unless submissions are paused", () => {
    const frame = run(toReview(), { type: "CONFIRM_SHOTS" });
    expect(run(frame, { type: "CONFIRM_FRAME", askConsent: true }).phase).toBe("select");
    expect(selectFour(frame, true).phase).toBe("consent");
    expect(selectFour(frame, false).phase).toBe("delivery");
  });
});

describe("delivery and consent are independent", () => {
  const toConsent = () => selectFour(run(toReview(), { type: "CONFIRM_SHOTS" }), true);
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

  it("ignores delivery events before the frame is final", () => {
    const frame = run(toReview(), { type: "CONFIRM_SHOTS" });
    expect(run(frame, ready)).toBe(frame);
    expect(run(frame, { type: "DELIVERY_STARTED" })).toBe(frame);
  });
});

describe("progress", () => {
  it("counts seven steps, or six while wall submissions are paused", () => {
    expect(progressStep("welcome", true)).toBeNull();
    expect(progressStep("pick", true)).toEqual({ step: 1, total: 7 });
    expect(progressStep("countdown", true)).toEqual({ step: 2, total: 7 });
    expect(progressStep("review", true)).toEqual({ step: 3, total: 7 });
    expect(progressStep("frame", true)).toEqual({ step: 4, total: 7 });
    expect(progressStep("select", true)).toEqual({ step: 5, total: 7 });
    expect(progressStep("consent", true)).toEqual({ step: 6, total: 7 });
    expect(progressStep("delivery", true)).toEqual({ step: 7, total: 7 });
    expect(progressStep("delivery", false)).toEqual({ step: 6, total: 6 });
  });
});

describe("reset", () => {
  it("clears the previous session entirely", () => {
    const done = run(
      toReview(),
      { type: "CONFIRM_SHOTS" },
      { type: "SELECT_FRAME", frameId: "wood-window" },
      { type: "CONFIRM_FRAME", askConsent: true },
      ...[0, 1, 2, 3].map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const),
      { type: "CONFIRM_SELECTION", askConsent: true },
      { type: "DELIVERY_SUCCEEDED", token: "t", url: "u", expiresAt: "e" },
      { type: "SET_CONSENT", consent: "yes" },
    );
    const s = run(done, { type: "RESET" });
    expect(s.phase).toBe("welcome");
    expect(s.sessionId).toBe("");
    expect(s.shots).toEqual([null, null, null, null, null, null]);
    expect(s.delivery).toEqual({ status: "idle" });
    expect(s.consent).toBeNull();
    expect(s.retakeIndex).toBeNull();
    expect(s.frameId).toBe("wood-window"); // last choice becomes the next default
  });

  it("each START begins a new session id", () => {
    const a = run(init(), { type: "START", sessionId: "a" });
    const b = run(a, { type: "RESET" }, { type: "START", sessionId: "b" });
    expect([a.sessionId, b.sessionId]).toEqual(["a", "b"]);
  });
});

describe("ordered selection", () => {
  const prepare = (id = "navy-strip") => run(toReview(),
    { type: "CONFIRM_SHOTS" }, { type: "SELECT_FRAME", frameId: id },
    { type: "CONFIRM_FRAME", askConsent: true });
  it("cannot confirm early and preserves selection order", () => {
    let s = prepare();
    expect(run(s, { type: "CONFIRM_SELECTION", askConsent: true })).toBe(s);
    s = run(s, ...[5, 1, 3].map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const));
    expect(s.selectedShotIndices).toEqual([5, 1, 3]);
    expect(run(s, { type: "CONFIRM_SELECTION", askConsent: true })).toBe(s);
    s = run(s, { type: "TOGGLE_SHOT_SELECTION", index: 0 }, { type: "CONFIRM_SELECTION", askConsent: true });
    expect([s.phase, s.selectedShotIndices]).toEqual(["consent", [5, 1, 3, 0]]);
  });
  it("accepts a 2-slot or a 6-slot template and prevents overflow", () => {
    let two = prepare("two-stars");
    two = run(two, ...[2, 4, 5].map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const));
    expect(two.selectedShotIndices).toEqual([2, 4]);
    expect(run(two, { type: "CONFIRM_SELECTION", askConsent: false }).phase).toBe("delivery");
    let six = prepare("six-lights");
    six = run(six, ...[5, 4, 3, 2, 1, 0].map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const));
    expect(run(six, { type: "CONFIRM_SELECTION", askConsent: true }).phase).toBe("consent");
  });
  it("deselects, and back returns to frame without uploading", () => {
    const s = run(prepare(), { type: "TOGGLE_SHOT_SELECTION", index: 2 },
      { type: "TOGGLE_SHOT_SELECTION", index: 2 }, { type: "BACK_TO_FRAME" });
    expect([s.phase, s.selectedShotIndices, s.delivery.status]).toEqual(["frame", [], "idle"]);
  });
});
