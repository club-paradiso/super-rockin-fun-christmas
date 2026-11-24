import { RETOUCH_CONFIG, type RetouchConfig } from "@/config/retouch";
import { RetouchError, type DetectedFace, type Point } from "./types";

/**
 * Finds the faces of one photo. The booth's implementation is MediaPipe Tasks Vision 0.10.21
 * with its non-SIMD WebAssembly build, self-hosted under public/retouch: Safari 15 on the iPad
 * mini 4 has no WebAssembly SIMD, and releases from 1.2.2 on ship a SIMD-only binary
 * (docs/research/skin-retouch-audit.md). Everything stays in this page: the points are used for
 * the mask of that one photo and dropped.
 */
export interface FaceFinder {
  readonly model: "landmarker" | "detector";
  /** Faces in photo pixels. Synchronous in MediaPipe: it cannot be interrupted once started. */
  detect(source: unknown, width: number, height: number): DetectedFace[];
  /**
   * The six-point detector alone, for the tile passes that look for small faces
   * (lib/retouch/find.ts). Absent when tiles are off.
   */
  detectPoints?(source: unknown, width: number, height: number): DetectedFace[];
  dispose(): void;
}

interface Landmark {
  x: number;
  y: number;
}

/** The part of @mediapipe/tasks-vision this module uses. */
interface VisionModule {
  FaceLandmarker: {
    createFromOptions(
      fileset: unknown,
      options: unknown,
    ): Promise<{
      detect(image: unknown): { faceLandmarks?: Landmark[][] };
      close(): void;
    }>;
  };
  FaceDetector: {
    createFromOptions(
      fileset: unknown,
      options: unknown,
    ): Promise<{
      detect(image: unknown): {
        detections?: { keypoints?: Landmark[]; categories?: { score?: number }[] }[];
      };
      close(): void;
    }>;
  };
}

/**
 * `work`, or "init-timeout" after `ms`. What `work` delivers after the timeout is nobody's: it
 * goes to `discard` (the face finder is closed), so a slow load that the booth has given up on
 * does not stay in the memory of a 2 GB tablet while the next attempt loads another one.
 */
export function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  discard: (late: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new RetouchError("init-timeout"));
    }, ms);
    work.then(
      (value) => {
        if (timedOut) {
          discard(value);
          return;
        }
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (timedOut) return;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function createMediaPipeFinder(
  config: RetouchConfig = RETOUCH_CONFIG,
  model: "landmarker" | "detector" = config.detection.model,
): Promise<FaceFinder> {
  const d = config.detection;
  const load = async (): Promise<FaceFinder> => {
    const vision = (await import("@mediapipe/tasks-vision")) as unknown as VisionModule;
    // The fileset is named here rather than resolved by FilesetResolver: the booth always loads
    // the non-SIMD build from its own origin, on every device, so one path is tested everywhere.
    const fileset = { wasmLoaderPath: d.wasmLoaderPath, wasmBinaryPath: d.wasmBinaryPath };
    // MediaPipe needs a WebGL context even with the CPU delegate; without a canvas of its own it
    // has failed on iOS (google-ai-edge/mediapipe#5609).
    const canvas = typeof document === "undefined" ? undefined : document.createElement("canvas");
    const scale = (points: Landmark[], w: number, h: number): Point[] =>
      points.map((p) => ({ x: p.x * w, y: p.y * h }));

    // The detector alone is all of "detector" mode, and the tile passes of "landmarker" mode.
    const needPoints = model === "detector" || config.detection.tileGrid > 1;
    const detector = needPoints
      ? await vision.FaceDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: d.detectorModelPath, delegate: "CPU" },
          runningMode: "IMAGE",
          canvas,
          minDetectionConfidence: d.minDetectionConfidence,
        })
      : null;
    const detectPoints = detector
      ? (source: unknown, w: number, h: number): DetectedFace[] =>
          (detector.detect(source).detections ?? []).flatMap((found) =>
            found.keypoints && found.keypoints.length >= 4
              ? [{ keypoints: scale(found.keypoints, w, h), score: found.categories?.[0]?.score }]
              : [],
          )
      : undefined;
    if (model === "detector") {
      return { model, detect: detectPoints!, detectPoints, dispose: () => detector!.close() };
    }
    // The detector is already up: if the landmarker does not come, close it rather than leave it.
    const landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: d.landmarkerModelPath, delegate: "CPU" },
      runningMode: "IMAGE",
      canvas,
      numFaces: d.maxFaces,
      minFaceDetectionConfidence: d.minDetectionConfidence,
      minFacePresenceConfidence: d.minPresenceConfidence,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    }).catch((error: unknown) => {
      detector?.close();
      throw error;
    });
    return {
      model,
      detect: (source, w, h) =>
        (landmarker.detect(source).faceLandmarks ?? []).map((points) => ({
          landmarks: scale(points, w, h),
        })),
      detectPoints,
      dispose: () => {
        landmarker.close();
        detector?.close();
      },
    };
  };
  try {
    return await withTimeout(load(), d.initTimeoutMs, (late) => late.dispose());
  } catch (error) {
    if (error instanceof RetouchError) throw error;
    throw new RetouchError("init-failed", error instanceof Error ? error.message : String(error));
  }
}
