import { act, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCameraEngine } from "@/components/kiosk/camera-engine";
import { CameraPreview } from "@/components/kiosk/ui";
import type { CameraProvider } from "@/lib/camera";
import type { CameraEngine } from "@/lib/camera-engine/engine";
import { defaultCameraEngine, type CameraEngineSettings } from "@/lib/camera-engine/settings";
import type { KioskPhase } from "@/lib/kiosk/machine";

const OFF = defaultCameraEngine();
const MANUAL: CameraEngineSettings = { ...OFF, mode: "manual", rollOffset: 5, pitchOffset: 8 };

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("the booth's engine hook", () => {
  const mount = (initial: CameraEngineSettings, phase: KioskPhase = "attract") =>
    renderHook(({ phase }: { phase: KioskPhase }) => useCameraEngine(initial, phase, "mock"), {
      initialProps: { phase },
    });

  it("is nothing at all while staff have it off", () => {
    const { result } = mount(OFF);
    expect(result.current.engine).toBeNull();
    expect(result.current.status()).toBeNull();
    // Never used here: the server hears nothing about it.
    expect(result.current.heartbeatStatus()).toBeUndefined();
    expect(() => result.current.requestPermission()).not.toThrow();
  });

  it("runs with the staff setting from the page's first render", () => {
    const { result } = mount(MANUAL);
    expect(result.current.engine).not.toBeNull();
    expect(result.current.status()).toMatchObject({ state: "manual", roll: 5, pitch: 8 });
    expect(result.current.heartbeatStatus()).toMatchObject({ state: "manual" });
  });

  it("takes a changed setting up between guests, never under one", () => {
    const { result, rerender } = mount(OFF, "ready");
    act(() => result.current.heard(MANUAL));
    // A guest is at the camera: nothing changes for them.
    expect(result.current.engine).toBeNull();
    rerender({ phase: "countdown" });
    rerender({ phase: "review" });
    expect(result.current.engine).toBeNull();
    // Back on "화면을 눌러 시작": the next guest gets it.
    rerender({ phase: "attract" });
    expect(result.current.engine).not.toBeNull();
    // And off again the same way, telling the server once that its status is gone.
    rerender({ phase: "ready" });
    expect(result.current.heartbeatStatus()).toMatchObject({ state: "manual" });
    act(() => result.current.heard(OFF));
    expect(result.current.engine).not.toBeNull();
    rerender({ phase: "attract" });
    expect(result.current.engine).toBeNull();
    expect(result.current.heartbeatStatus()).toBeNull();
    expect(result.current.heartbeatStatus()).toBeUndefined();
  });

  it("fixes the correction from the first countdown until the guest is gone, a retake included", () => {
    const { result, rerender } = mount(MANUAL);
    const engine = result.current.engine!;
    for (const phase of ["welcome", "pick", "camera", "ready"] as KioskPhase[]) {
      rerender({ phase });
      expect(engine.isLocked()).toBe(false);
    }
    for (const phase of [
      "countdown",
      "capturing",
      "countdown",
      "review",
      // 「다시 찍기」
      "camera",
      "ready",
      "countdown",
      "review",
      "select",
      "consent",
      "delivery",
    ] as KioskPhase[]) {
      rerender({ phase });
      expect(engine.isLocked()).toBe(true);
    }
    rerender({ phase: "attract" });
    expect(engine.isLocked()).toBe(false);
  });

  it("lets one tablet's address override the staff setting", () => {
    window.history.replaceState(null, "", "/kiosk?engine=manual&tilt=-3,4");
    const on = mount(OFF);
    expect(on.result.current.status()).toMatchObject({ state: "manual", roll: -3, pitch: 4 });
    on.unmount();
    window.history.replaceState(null, "", "/kiosk?engine=off");
    const off = mount(MANUAL);
    expect(off.result.current.engine).toBeNull();
    // Staff have it on and this tablet does not: the server is told there is no status.
    expect(off.result.current.heartbeatStatus()).toBeNull();
  });

  it("tells the engine which camera is running, and guesses nothing about a hand-picked one", () => {
    const { result } = mount({ ...OFF, mode: "auto" });
    const camera = (kind: CameraProvider["kind"], facingMode?: string) =>
      ({
        kind,
        getStream: () => ({ getVideoTracks: () => [{ getSettings: () => ({ facingMode }) }] }),
      }) as unknown as CameraProvider;
    const reason = () => result.current.status()!.reason;
    act(() => result.current.cameraStarted(camera("browser", "user"), undefined));
    expect(reason()).not.toBe("camera-unknown");
    // The booth's default request is the front camera, even where the browser does not say.
    act(() => result.current.cameraStarted(camera("browser"), undefined));
    expect(reason()).not.toBe("camera-unknown");
    // jsdom has no motion sensors, so the reason here is the missing sensor either way; with
    // a hand-picked camera of unknown facing the engine must not be told "user".
    const spy = vi.spyOn(result.current.engine!, "setCamera");
    act(() => result.current.cameraStarted(camera("browser"), "usb-camera-1"));
    expect(spy).toHaveBeenLastCalledWith({ kind: "browser", facing: null });
    act(() => result.current.cameraStarted(camera("remote"), undefined));
    expect(spy).toHaveBeenLastCalledWith({ kind: "remote", facing: null });
    act(() => result.current.cameraStarted(camera("mock"), undefined));
    expect(spy).toHaveBeenLastCalledWith({ kind: "mock", facing: "user" });
  });
});

describe("the preview element", () => {
  const layout = {
    left: -66.5,
    top: 0,
    width: 533,
    height: 300,
    transform: "matrix3d(-1,0,0,0,0,1,0,0,0,0,1,0,533,0,0,1)",
  };
  function fakeEngine(preview: () => typeof layout | null) {
    const listeners = new Set<() => void>();
    const engine = {
      preview: vi.fn(preview),
      subscribe: vi.fn((listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    return { engine: engine as unknown as CameraEngine, listeners, spies: engine };
  }
  const video = (container: HTMLElement) =>
    container.querySelector<HTMLVideoElement>('[data-testid="camera-preview"]')!;

  it("without an engine is the element the booth always had", () => {
    const { container } = render(<CameraPreview stream={null} aspect={4 / 3} mirror />);
    expect(video(container).style.transform).toBe("scaleX(-1)");
    expect(video(container).style.position).toBe("");
    expect(video(container).dataset.engine).toBeUndefined();
  });

  it("takes the engine's layout, follows its changes, and gives everything back", () => {
    let current: typeof layout | null = layout;
    const { engine, listeners, spies } = fakeEngine(() => current);
    const { container, rerender, unmount } = render(
      <CameraPreview stream={null} aspect={4 / 3} mirror engine={engine} />,
    );
    const v = video(container);
    expect(v.style.transform).toBe(layout.transform);
    expect([v.style.position, v.style.left, v.style.width, v.style.height]).toEqual([
      "absolute",
      "-66.5px",
      "533px",
      "300px",
    ]);
    expect(v.style.objectFit).toBe("fill");
    expect(v.dataset.engine).toBe("on");
    expect(spies.preview).toHaveBeenLastCalledWith(0, 0, 0, 0, 4 / 3, true);

    // The engine has nothing to correct any more (the booth was straightened).
    current = null;
    act(() => listeners.forEach((l) => l()));
    expect(v.style.transform).toBe("scaleX(-1)");
    expect(v.style.position).toBe("");
    expect(v.dataset.engine).toBeUndefined();

    // Staff turned it off between guests.
    current = layout;
    act(() => listeners.forEach((l) => l()));
    expect(v.dataset.engine).toBe("on");
    rerender(<CameraPreview stream={null} aspect={4 / 3} mirror engine={null} />);
    expect(v.style.transform).toBe("scaleX(-1)");
    expect(listeners.size).toBe(0);
    unmount();
  });

  it("keeps an unmirrored preview unmirrored", () => {
    const { container } = render(<CameraPreview stream={null} aspect={4 / 3} mirror={false} />);
    expect(video(container).style.transform).toBe("");
  });
});
