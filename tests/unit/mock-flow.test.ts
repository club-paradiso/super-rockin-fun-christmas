import { describe, expect, it } from "vitest";
import { getFrame } from "@/config/frames";
import { KIOSK_CONFIG } from "@/config/kiosk";
import { MockCamera, type CapturedFrame } from "@/lib/camera";
import { composeFrame } from "@/lib/compositor";
import {
  createInitialState,
  kioskReducer,
  type KioskAction,
  type KioskState,
} from "@/lib/kiosk/machine";
import { releaseUrls } from "@/lib/kiosk/session";
import { fakeCanvasFactory } from "../helpers/fake-canvas";

/**
 * The whole first vertical slice without a physical camera or a browser: the same reducer and
 * camera/compositor code the kiosk uses, driven the way KioskApp's effects drive them.
 */
describe("mock camera flow", () => {
  it("completes welcome → 4 captures → composite → reset", async () => {
    const { factory } = fakeCanvasFactory();
    const camera = new MockCamera({ createCanvas: factory });
    let state: KioskState<CapturedFrame> = createInitialState({
      shotCount: KIOSK_CONFIG.shotsPerSession,
      countdownSeconds: KIOSK_CONFIG.countdownSeconds,
    });
    const dispatch = (a: KioskAction<CapturedFrame>) => (state = kioskReducer(state, a));

    dispatch({ type: "OPEN" });
    dispatch({ type: "START", sessionId: crypto.randomUUID() });
    // 필름 4컷 · 빨강: a card with an option and the handwriting.
    dispatch({ type: "SELECT_CARD", cardId: "film4" });
    dispatch({ type: "CONFIRM_PICK", random: 0.5 });
    dispatch({ type: "SET_OPTION", key: "color", value: "red" });
    dispatch({ type: "CONFIRM_OPTIONS", random: 0.5 });
    expect(state.frameId).toBe("film4-red");
    expect(state.handFont).not.toBeNull();
    await camera.start();
    dispatch({ type: "CAMERA_READY" });
    dispatch({ type: "BEGIN_SHOOTING", guide: false });

    let guard = 0;
    while (state.phase === "countdown" || state.phase === "capturing") {
      if (++guard > 100) throw new Error("flow did not terminate");
      if (state.phase === "countdown") dispatch({ type: "TICK" });
      else {
        dispatch({
          type: "SHOT_CAPTURED",
          shot: await camera.capture({
            aspect: KIOSK_CONFIG.captureAspect,
            mirror: KIOSK_CONFIG.mirror,
            maxWidth: KIOSK_CONFIG.captureMaxWidth,
          }),
        });
      }
    }

    expect(state.phase).toBe("review");
    expect(camera.captureCount).toBe(KIOSK_CONFIG.shotsPerSession);

    dispatch({ type: "CONFIRM_SHOTS" });
    expect(state.phase).toBe("select");
    for (const index of [3, 1, 2, 0]) dispatch({ type: "TOGGLE_SHOT_SELECTION", index });
    dispatch({ type: "CONFIRM_SELECTION", askConsent: true });
    expect(state.phase).toBe("consent");

    const frame = getFrame(state.frameId);
    const images = state.selectedShotIndices
      .map((i) => state.shots[i])
      .map((s) => ({
        source: s!.canvas as unknown as CanvasImageSource,
        width: s!.width,
        height: s!.height,
      }));
    const output = composeFrame(frame, images, {
      createCanvas: factory,
      context: { dateLabel: "2026.12.24", stampLabel: "'26 12 24", handFont: state.handFont! },
      scale: KIOSK_CONFIG.outputScale,
    });
    expect([output.width, output.height]).toEqual([1200, 3600]);

    const revoked: string[] = [];
    releaseUrls(["blob:a", null, "blob:b"], (u) => revoked.push(u));
    expect(revoked).toEqual(["blob:a", "blob:b"]);

    dispatch({ type: "RESET" });
    camera.stop();
    expect(state.phase).toBe("attract");
    expect(state.shots.every((s) => s === null)).toBe(true);
    expect(camera.isActive()).toBe(false);
  });
});
