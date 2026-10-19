import { describe, expect, it } from "vitest";
import {
  MAX_CAPTURE_FAILURES,
  capturedCount,
  createInitialState,
  kioskReducer,
  type KioskAction,
  type KioskState,
} from "@/lib/kiosk/machine";

type S = KioskState<string>;
const SESSION = "11111111-2222-4333-8444-555555555555";

function init(): S {
  return createInitialState<string>({
    shotCount: 6,
    countdownSeconds: 3,
    frameId: "starlight-strip",
  });
}

function run(state: S, ...actions: KioskAction<string>[]): S {
  return actions.reduce(kioskReducer<string>, state);
}

const toReady = (s = init()) =>
  run(s, { type: "START", sessionId: SESSION }, { type: "CAMERA_READY" });
const ticks = (n: number) => Array.from({ length: n }, () => ({ type: "TICK" }) as const);

/** Count down and capture one shot. */
const shoot = (s: S, label: string) =>
  run(s, ...ticks(s.remaining), { type: "SHOT_CAPTURED", shot: label });

function toReview(): S {
  let s = run(toReady(), { type: "BEGIN_SHOOTING" });
  for (let i = 0; i < 6; i++) s = shoot(s, `shot-${i}`);
  return s;
}

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

describe("delivery and consent are independent", () => {
  const toFinal = () =>
    run(
      toReview(),
      { type: "CONFIRM_SHOTS" },
      { type: "CONFIRM_FRAME" },
      ...[0, 1, 2, 3].map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const),
      { type: "CONFIRM_SELECTION" },
    );

  it("declining the wall keeps the delivered link", () => {
    let s = run(
      toFinal(),
      { type: "REQUEST_DELIVERY" },
      { type: "DELIVERY_STARTED" },
      {
        type: "DELIVERY_SUCCEEDED",
        token: "t",
        url: "https://x/p/t",
        expiresAt: "2026-12-27T00:00:00Z",
      },
      { type: "TO_CONSENT" },
      { type: "SET_CONSENT", consent: "no" },
    );
    expect(s.phase).toBe("complete");
    expect(s.consent).toBe("no");
    expect(s.delivery).toMatchObject({ status: "ready", token: "t" });
    s = run(s, { type: "SET_CONSENT", consent: "yes" });
    expect(s.consent).toBe("no"); // answer is final once complete
  });

  it("hub + cloud: QR pending → link arrives → ready; pending never replaces a ready QR", () => {
    let s = run(
      toFinal(),
      { type: "REQUEST_DELIVERY" },
      { type: "DELIVERY_STARTED" },
      { type: "DELIVERY_QR_PENDING" },
    );
    expect(s.delivery).toEqual({ status: "qr-pending" });
    s = run(s, {
      type: "DELIVERY_SUCCEEDED",
      token: "t",
      url: "https://x/p/t",
      expiresAt: "2026-12-27T00:00:00Z",
    });
    expect(s.delivery).toMatchObject({ status: "ready", url: "https://x/p/t" });
    s = run(s, { type: "DELIVERY_QR_PENDING" });
    expect(s.delivery.status).toBe("ready");
  });

  it("QR pending: the guest can still answer the wall question", () => {
    const s = run(
      toFinal(),
      { type: "REQUEST_DELIVERY" },
      { type: "DELIVERY_QR_PENDING" },
      { type: "TO_CONSENT" },
      { type: "SET_CONSENT", consent: "yes" },
    );
    expect([s.phase, s.consent]).toEqual(["complete", "yes"]);
  });

  it("a failed delivery can still finish the session", () => {
    const s = run(
      toFinal(),
      { type: "REQUEST_DELIVERY" },
      { type: "DELIVERY_FAILED", message: "offline" },
      { type: "FINISH" },
    );
    expect(s.phase).toBe("complete");
    expect(s.consent).toBeNull();
  });

  it("frame choice can change from the final preview", () => {
    const s = run(
      toFinal(),
      { type: "BACK_TO_FRAME" },
      { type: "SELECT_FRAME", frameId: "village-window" },
    );
    expect([s.phase, s.frameId]).toEqual(["frame", "village-window"]);
  });
});

describe("reset", () => {
  it("clears the previous session entirely", () => {
    const done = run(
      toReview(),
      { type: "CONFIRM_SHOTS" },
      { type: "SELECT_FRAME", frameId: "village-window" },
      { type: "CONFIRM_FRAME" },
      ...[0, 1, 2, 3].map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const),
      { type: "CONFIRM_SELECTION" },
      { type: "REQUEST_DELIVERY" },
      { type: "DELIVERY_SUCCEEDED", token: "t", url: "u", expiresAt: "e" },
      { type: "TO_CONSENT" },
      { type: "SET_CONSENT", consent: "yes" },
    );
    const s = run(done, { type: "RESET" });
    expect(s.phase).toBe("welcome");
    expect(s.sessionId).toBe("");
    expect(s.shots).toEqual([null, null, null, null]);
    expect(s.delivery).toEqual({ status: "idle" });
    expect(s.consent).toBeNull();
    expect(s.retakeIndex).toBeNull();
  });

  it("each START begins a new session id", () => {
    const a = run(init(), { type: "START", sessionId: "a" });
    const b = run(a, { type: "RESET" }, { type: "START", sessionId: "b" });
    expect([a.sessionId, b.sessionId]).toEqual(["a", "b"]);
  });
});

describe("per-template ordered photo selection", () => {
  const selectState = (frameId: string) =>
    run(toReview(), { type: "CONFIRM_SHOTS" }, { type: "SELECT_FRAME", frameId }, { type: "CONFIRM_FRAME" });

  it.each([
    ["two-stars", [4, 1]],
    ["three-moments", [3, 0, 5]],
    ["starlight-strip", [5, 2, 0, 1]],
    ["five-lights", [5, 4, 3, 2, 1]],
    ["six-lights", [5, 4, 3, 2, 1, 0]],
  ] as const)("%s finishes only with the exact selected count", (frameId, indexes) => {
    let state = selectState(frameId);
    expect(state.phase).toBe("select");
    expect(run(state, { type: "CONFIRM_SELECTION" }).phase).toBe("select");
    for (const index of indexes) state = run(state, { type: "TOGGLE_SHOT_SELECTION", index });
    expect(state.selectedShotIndices).toEqual(indexes);
    expect(run(state, { type: "CONFIRM_SELECTION" }).phase).toBe("final");
  });

  it("ignores duplicate/out-of-range choices and limits to template slots", () => {
    let state = selectState("two-stars");
    state = run(state, { type: "TOGGLE_SHOT_SELECTION", index: 0 });
    state = run(state, { type: "TOGGLE_SHOT_SELECTION", index: 1 });
    expect(run(state, { type: "TOGGLE_SHOT_SELECTION", index: 2 })).toBe(state);
    expect(run(state, { type: "TOGGLE_SHOT_SELECTION", index: 6 })).toBe(state);
    state = run(state, { type: "TOGGLE_SHOT_SELECTION", index: 0 });
    expect(state.selectedShotIndices).toEqual([1]);
    expect(run(state, { type: "CONFIRM_SELECTION" }).phase).toBe("select");
  });

  it("changing frame resets selection; returning from final preserves it until frame changes", () => {
    let state = selectState("two-stars");
    state = run(state, { type: "TOGGLE_SHOT_SELECTION", index: 4 }, { type: "TOGGLE_SHOT_SELECTION", index: 2 }, { type: "CONFIRM_SELECTION" });
    expect(state.phase).toBe("final");
    state = run(state, { type: "BACK_TO_SELECTION" });
    expect(state.selectedShotIndices).toEqual([4, 2]);
    state = run(state, { type: "BACK_TO_FRAME" }, { type: "SELECT_FRAME", frameId: "six-lights" });
    expect(state.selectedShotIndices).toEqual([]);
  });
});
