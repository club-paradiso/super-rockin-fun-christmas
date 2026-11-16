import { BrowserCamera } from "./browser-camera";
import { MockCamera } from "./mock-camera";
import { RemoteCamera } from "./remote-camera";
import type { CameraProvider } from "./types";

export * from "./types";
export { BrowserCamera, toCameraError } from "./browser-camera";
export { MockCamera } from "./mock-camera";
export { RemoteCamera, type RemoteMetrics } from "./remote-camera";
export { grabFrame } from "./capture";

export type CameraMode = "browser" | "mock" | "remote";

/**
 * `?camera=mock|remote|browser` in the URL wins over NEXT_PUBLIC_CAMERA_MODE; default is the
 * webcam in this browser. "remote" is the paired iPhone (docs/REMOTE_CAMERA.md). Anything else
 * (a typo, an old value) is the webcam, so a wrong setting never leaves the booth without one.
 */
export function resolveCameraMode(
  queryValue: string | null | undefined,
  envMode: string | undefined,
): CameraMode {
  const mode = queryValue ?? envMode;
  return mode === "mock" || mode === "remote" ? mode : "browser";
}

export function createCamera(mode: CameraMode): CameraProvider {
  if (mode === "mock") return new MockCamera();
  if (mode === "remote") return new RemoteCamera();
  return new BrowserCamera();
}
