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
    shotCount: 4,
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
  for (let i = 0; i < 4; i++) s = shoot(s, `shot-${i}`);
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

describe("exactly four captures", () => {
  it("goes to review after the fourth shot, in order", () => {
    const s = toReview();
    expect(s.phase).toBe("review");
    expect(s.shots).toEqual(["shot-0", "shot-1", "shot-2", "shot-3"]);
    expect(capturedCount(s)).toBe(4);
  });

  it("rejects a stray fifth frame", () => {
    const s = toReview();
    expect(run(s, { type: "SHOT_CAPTURED", shot: "extra" })).toBe(s);
  });

  it("does not accept a shot while still counting down", () => {
    const s = run(toReady(), { type: "BEGIN_SHOOTING" });
    expect(run(s, { type: "SHOT_CAPTURED", shot: "early" })).toBe(s);
  });

  it("only confirms when all four exist", () => {
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
    expect(s.shots).toEqual(["shot-0", "shot-1", "new-2", "shot-3"]);
    expect(s.retakeIndex).toBeNull();
  });

  it("retake all clears every shot and starts from the first", () => {
    const s = run(toReview(), { type: "RETAKE_ALL" });
    expect(s.shots).toEqual([null, null, null, null]);
    expect([s.phase, s.shotIndex]).toEqual(["countdown", 0]);
  });

  it("ignores out-of-range retakes", () => {
    const s = toReview();
    expect(run(s, { type: "RETAKE", index: 4 })).toBe(s);
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
  const toFinal = () => run(toReview(), { type: "CONFIRM_SHOTS" }, { type: "CONFIRM_FRAME" });

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
