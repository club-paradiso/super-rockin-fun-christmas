import { BrowserCamera } from "./browser-camera";
import { MockCamera } from "./mock-camera";
import type { CameraProvider } from "./types";

export * from "./types";
export { BrowserCamera, toCameraError } from "./browser-camera";
export { MockCamera } from "./mock-camera";
export { grabFrame } from "./capture";

export type CameraMode = "browser" | "mock";

/** `?camera=mock` in the URL wins over NEXT_PUBLIC_CAMERA_MODE; default is the real camera. */
export function resolveCameraMode(
  queryValue: string | null | undefined,
  envMode: string | undefined,
): CameraMode {
  const mode = queryValue ?? envMode;
  return mode === "mock" ? "mock" : "browser";
}

export function createCamera(mode: CameraMode): CameraProvider {
  return mode === "mock" ? new MockCamera() : new BrowserCamera();
}
