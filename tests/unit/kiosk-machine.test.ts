import { describe, expect, it } from "vitest";
import { POSE_SEQUENCE } from "@/config/poses";
import { KIOSK_COPY } from "@/lib/kiosk/copy";
import {
  MAX_CAPTURE_FAILURES,
  canGoBack,
  capturedCount,
  createInitialState as attractState,
  currentPose,
  kioskReducer,
  progressStep,
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
  let s = run(toReady(), { type: "BEGIN_SHOOTING", guide: false });
  for (let i = 0; i < 6; i++) s = shoot(s, `shot-${i}`);
  return s;
}

const selectFour = (frame: S, askConsent: boolean) =>
  run(
    frame,
    { type: "CONFIRM_FRAME", askConsent },
    ...[0, 1, 2, 3].map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const),
    { type: "CONFIRM_SELECTION", askConsent },
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

describe("frame first, then again with the photos", () => {
  it("start → pick a frame → camera; the choice is preselected after shooting", () => {
    let s = run(init(), { type: "START", sessionId: SESSION });
    expect(s.phase).toBe("pick");
    s = run(s, { type: "SELECT_FRAME", frameId: "clothesline" }, { type: "CONFIRM_PICK" });
    expect([s.phase, s.frameId]).toEqual(["camera", "clothesline"]);
    s = run(s, { type: "CAMERA_READY" }, { type: "BEGIN_SHOOTING", guide: false });
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
    expect(s.phase).toBe("attract");
    expect(s.sessionId).toBe("");
    expect(s.shots).toEqual([null, null, null, null, null, null]);
    expect(s.delivery).toEqual({ status: "idle" });
    expect(s.consent).toBeNull();
    expect(s.retakeIndex).toBeNull();
    expect(s.frameId).toBe("wood-window"); // last choice becomes the next default
  });

  it("each START begins a new session id", () => {
    const a = run(init(), { type: "START", sessionId: "a" });
    const b = run(a, { type: "RESET" }, { type: "OPEN" }, { type: "START", sessionId: "b" });
    expect([a.sessionId, b.sessionId]).toEqual(["a", "b"]);
  });
});

describe("ordered selection", () => {
  const prepare = (id = "navy-strip") =>
    run(
      toReview(),
      { type: "CONFIRM_SHOTS" },
      { type: "SELECT_FRAME", frameId: id },
      { type: "CONFIRM_FRAME", askConsent: true },
    );
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
  it("accepts a 1-slot, a 2-slot or a 6-slot template and prevents overflow", () => {
    let one = prepare("shalom-single");
    one = run(one, ...[3, 1].map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const));
    expect(one.selectedShotIndices).toEqual([3]);
    expect(run(one, { type: "CONFIRM_SELECTION", askConsent: true }).phase).toBe("consent");
    let two = prepare("shalom-postcard");
    two = run(
      two,
      ...[2, 4, 5].map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const),
    );
    expect(two.selectedShotIndices).toEqual([2, 4]);
    expect(run(two, { type: "CONFIRM_SELECTION", askConsent: false }).phase).toBe("delivery");
    let six = prepare("shalom-stamps");
    six = run(
      six,
      ...[5, 4, 3, 2, 1, 0].map((index) => ({ type: "TOGGLE_SHOT_SELECTION", index }) as const),
    );
    expect(run(six, { type: "CONFIRM_SELECTION", askConsent: true }).phase).toBe("consent");
  });
  it("deselects, and back returns to frame without uploading", () => {
    const s = run(
      prepare(),
      { type: "TOGGLE_SHOT_SELECTION", index: 2 },
      { type: "TOGGLE_SHOT_SELECTION", index: 2 },
      { type: "BACK_TO_FRAME" },
    );
    expect([s.phase, s.selectedShotIndices, s.delivery.status]).toEqual(["frame", [], "idle"]);
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

  it("retaking shot i shows pose i; retake all starts from the first pose", () => {
    let s = begin(true);
    for (let i = 0; i < 6; i++) s = shoot(s, `g-${i}`);
    const retake = run(s, { type: "RETAKE", index: 4 });
    expect(currentPose(retake)).toEqual(POSE_SEQUENCE[4]);
    expect(currentPose(run(s, { type: "RETAKE_ALL" }))).toEqual(POSE_SEQUENCE[0]);
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
      { type: "CONFIRM_PICK" },
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
    // Korean only where it names something Korean on purpose: the language picker's own label
    // and the phone page's button, quoted with its English meaning.
    const allowed = new Set([".langGroup", ".mobile.steps.2"]);
    for (const [path, text] of strings(KIOSK_COPY.en))
      if (!allowed.has(path)) expect(hangul.test(text), `${path}: ${text}`).toBe(false);
    // The Chinese screens are Chinese, not English: every string has Han characters, except
    // where it names something on purpose (the event name, the language picker's label).
    const han = /\p{Script=Han}/u;
    const notChinese = new Set([".attract.event", ".langGroup"]);
    for (const [path, text] of strings(KIOSK_COPY.zh))
      if (!notChinese.has(path)) {
        expect(han.test(text), `${path}: ${text}`).toBe(true);
        // No Korean either, except the phone page's button, quoted with its Chinese meaning.
        if (path !== ".mobile.steps.2") expect(hangul.test(text), `${path}: ${text}`).toBe(false);
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

  it("camera before the first shot → frame pick", () => {
    const s = toReady();
    expect(canGoBack(s)).toBe(true);
    expect(run(s, { type: "BACK" }).phase).toBe("pick");
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
    const frame = run(review, { type: "CONFIRM_SHOTS" });
    expect(canGoBack(frame)).toBe(false);
    const consent = selectFour(frame, true);
    expect(consent.phase).toBe("consent");
    expect(canGoBack(consent)).toBe(false);
    expect(run(consent, { type: "BACK" })).toBe(consent);
  });

  it("photo selection → frame, with the selection cleared", () => {
    const select = run(
      toReview(),
      { type: "CONFIRM_SHOTS" },
      { type: "CONFIRM_FRAME", askConsent: true },
      { type: "TOGGLE_SHOT_SELECTION", index: 2 },
    );
    expect(canGoBack(select)).toBe(true);
    const back = run(select, { type: "BACK" });
    expect([back.phase, back.selectedShotIndices, capturedCount(back)]).toEqual(["frame", [], 6]);
  });
});

describe("attract screen (D80): 화면을 눌러 시작", () => {
  const fresh = () =>
    attractState<string>({ shotCount: 6, countdownSeconds: 3, frameId: "navy-strip" });

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
