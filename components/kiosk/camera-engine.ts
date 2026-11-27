"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CameraMode, CameraProvider } from "@/lib/camera";
import { CameraEngine } from "@/lib/camera-engine/engine";
import {
  cameraEngineFromAddress,
  sameCameraEngine,
  type CameraEngineSettings,
} from "@/lib/camera-engine/settings";
import type { CameraEngineStatus } from "@/lib/camera-engine/status";
import type { KioskPhase } from "@/lib/kiosk/machine";

/**
 * The Intelligent Camera Engine on the booth (lib/camera-engine, docs/CAMERA_ENGINE.md): the
 * staff setting as the booth last heard it, taken up only between guests; one engine for the
 * page; the session lock. While the setting is "off" (the default) `engine` is null and the
 * booth runs exactly as it did before the engine existed.
 */
export interface BoothCameraEngine {
  /** The engine while staff have it on, else null. */
  engine: CameraEngine | null;
  /** Changes whenever the correction may have changed: the preview follows it. */
  tick: number;
  /** A heartbeat brought the staff setting. */
  heard: (settings: CameraEngineSettings) => void;
  /** Inside the "화면을 눌러 시작" touch: iOS only answers the sensor question there. */
  requestPermission: () => void;
  /** The camera is running: which one it is. */
  cameraStarted: (camera: CameraProvider, deviceId: string | undefined) => void;
  /**
   * For the heartbeat: the status while on, `null` once after it was turned off (so the
   * server forgets the old one), otherwise `undefined` (nothing is sent).
   */
  heartbeatStatus: () => CameraEngineStatus | null | undefined;
  /** For the staff help menu; null while off. */
  status: () => CameraEngineStatus | null;
}

export function useCameraEngine(
  initial: CameraEngineSettings,
  phase: KioskPhase,
  cameraMode: CameraMode,
): BoothCameraEngine {
  // What staff set, as the booth last heard it, and what this guest's session runs with. A
  // change is taken up only on "화면을 눌러 시작": never under a guest, whose preview and
  // photos would otherwise stop agreeing half way.
  const [heardSettings, setHeardSettings] = useState(initial);
  const [sessionSettings, setSessionSettings] = useState(initial);
  if (phase === "attract" && !sameCameraEngine(heardSettings, sessionSettings))
    setSessionSettings(heardSettings);

  const engineRef = useRef<CameraEngine | null>(null);
  const [engine, setEngine] = useState<CameraEngine | null>(null);
  const [tick, setTick] = useState(0);
  const reportedRef = useRef(false);

  // One engine for the page: the answer to the sensor question lives in it, so a change of
  // settings never asks a guest again.
  useEffect(() => {
    const created = new CameraEngine();
    engineRef.current = created;
    const off = created.subscribe(() => setTick((n) => n + 1));
    return () => {
      off();
      created.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const current = engineRef.current;
    if (!current) return;
    // `?engine=` and `?tilt=` on this tablet's address win (a test and acceptance tool).
    current.configure(cameraEngineFromAddress(window.location.search, sessionSettings));
    if (cameraMode === "remote") current.setCamera({ kind: "remote", facing: null });
    setEngine(current.active() ? current : null);
  }, [sessionSettings, cameraMode]);

  // The correction is fixed from a guest's first countdown until they are gone (a retake
  // included); between guests the booth watches the sensors again.
  useEffect(() => {
    const current = engineRef.current;
    if (!current) return;
    if (phase === "countdown" || phase === "capturing") current.lock();
    else if (phase === "attract") current.newSession();
  }, [phase]);

  const heard = useCallback((settings: CameraEngineSettings) => {
    setHeardSettings((previous) => (sameCameraEngine(previous, settings) ? previous : settings));
  }, []);
  const requestPermission = useCallback(() => engineRef.current?.requestPermission(), []);
  const cameraStarted = useCallback((camera: CameraProvider, deviceId: string | undefined) => {
    const current = engineRef.current;
    if (!current) return;
    if (camera.kind !== "browser") {
      current.setCamera({ kind: camera.kind, facing: camera.kind === "mock" ? "user" : null });
      return;
    }
    let facing: string | undefined;
    try {
      facing = camera.getStream()?.getVideoTracks()[0]?.getSettings?.().facingMode;
    } catch {
      facing = undefined;
    }
    current.setCamera({
      kind: "browser",
      facing:
        facing === "user" || facing === "environment"
          ? facing
          : // The booth asks for the front camera unless staff chose a device by hand; a
            // hand-picked camera that does not say which way it looks is not guessed at.
            deviceId
            ? null
            : "user",
    });
  }, []);
  const status = useCallback(() => {
    const current = engineRef.current;
    return current?.active() ? current.status() : null;
  }, []);
  const heartbeatStatus = useCallback(() => {
    const now = status();
    if (now) {
      reportedRef.current = true;
      return now;
    }
    if (!reportedRef.current) return undefined;
    reportedRef.current = false;
    return null;
  }, [status]);

  return { engine, tick, heard, requestPermission, cameraStarted, heartbeatStatus, status };
}
