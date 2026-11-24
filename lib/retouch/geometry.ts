import type { DetectedFace, FaceGeometry, Point, Rect } from "./types";

/**
 * A detected face as polygons. Two sources:
 *  - the MediaPipe face mesh (468 points or more): the outline, eyes, brows and lips are the
 *    mesh's own contours (the index lists below are MediaPipe's FACEMESH_* connection sets,
 *    walked as closed loops);
 *  - the six BlazeFace points: ellipses placed from the eyes, nose tip and mouth, sized by the
 *    distance between the eyes. Rougher, and one inference per photo instead of one per face.
 *
 * Shape only: nothing here estimates who a face is, its age, or anything else about the person.
 */

export const MESH = {
  outline: [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152,
    148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
  ],
  rightEye: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  leftEye: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  rightBrow: [46, 53, 52, 65, 55, 107, 66, 105, 63, 70],
  leftBrow: [276, 283, 282, 295, 285, 336, 296, 334, 293, 300],
  lips: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185],
  rightCheek: 234,
  leftCheek: 454,
  rightEyeOuter: 33,
  rightEyeInner: 133,
  leftEyeInner: 362,
  leftEyeOuter: 263,
  noseBase: 2,
  rightNoseWing: 98,
  leftNoseWing: 327,
} as const;

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function boundsOf(points: readonly Point[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** An ellipse as a polygon. `axis` is the unit vector of the `rx` radius. */
export function ellipse(
  center: Point,
  rx: number,
  ry: number,
  axis: Point,
  segments = 20,
): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const u = Math.cos(t) * rx;
    const v = Math.sin(t) * ry;
    // (axis.x, axis.y) along the ellipse's width, (-axis.y, axis.x) along its height.
    out.push({ x: center.x + u * axis.x - v * axis.y, y: center.y + u * axis.y + v * axis.x });
  }
  return out;
}

/** The zone under an eye: an ellipse below the lid, as wide as the eye. */
function underEye(eyeCenter: Point, eyeWidth: number, across: Point, down: Point): Point[] {
  const center = {
    x: eyeCenter.x + down.x * eyeWidth * 0.5,
    y: eyeCenter.y + down.y * eyeWidth * 0.5,
  };
  return ellipse(center, eyeWidth * 0.62, eyeWidth * 0.27, across);
}

function finite(points: readonly Point[]): boolean {
  return points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

function fromMesh(lm: readonly Point[]): FaceGeometry | null {
  const pick = (indices: readonly number[]) => indices.map((i) => lm[i]!);
  const outline = pick(MESH.outline);
  const rightEye = pick(MESH.rightEye);
  const leftEye = pick(MESH.leftEye);
  const features = [rightEye, leftEye, pick(MESH.rightBrow), pick(MESH.leftBrow), pick(MESH.lips)];
  if (!finite(outline) || !features.every(finite)) return null;

  const width = dist(lm[MESH.rightCheek]!, lm[MESH.leftCheek]!);
  if (!(width > 0)) return null;
  const rCenter = mid(lm[MESH.rightEyeOuter]!, lm[MESH.rightEyeInner]!);
  const lCenter = mid(lm[MESH.leftEyeInner]!, lm[MESH.leftEyeOuter]!);
  const iod = dist(rCenter, lCenter);
  if (!(iod > 0)) return null;
  const across = { x: (lCenter.x - rCenter.x) / iod, y: (lCenter.y - rCenter.y) / iod };
  // Towards the chin: the perpendicular that points from the eyes to the nose base.
  const base = lm[MESH.noseBase]!;
  const eyesMid = mid(rCenter, lCenter);
  let down = { x: -across.y, y: across.x };
  if ((base.x - eyesMid.x) * down.x + (base.y - eyesMid.y) * down.y < 0)
    down = { x: -down.x, y: -down.y };

  // Nostril openings: between the nose base and each wing, a little below the tip.
  const nostril = (wing: Point) =>
    ellipse(
      {
        x: base.x + (wing.x - base.x) * 0.55 - down.x * width * 0.008,
        y: base.y + (wing.y - base.y) * 0.55 - down.y * width * 0.008,
      },
      width * 0.045,
      width * 0.028,
      across,
      12,
    );
  features.push(nostril(lm[MESH.rightNoseWing]!), nostril(lm[MESH.leftNoseWing]!));

  const rWidth = dist(lm[MESH.rightEyeOuter]!, lm[MESH.rightEyeInner]!);
  const lWidth = dist(lm[MESH.leftEyeInner]!, lm[MESH.leftEyeOuter]!);
  return {
    outline,
    features,
    underEyes: [underEye(rCenter, rWidth, across, down), underEye(lCenter, lWidth, across, down)],
    width,
    box: boundsOf(outline),
  };
}

/**
 * From the six BlazeFace points. The proportions are of an average frontal face, in units of the
 * distance between the eyes (IOD): face width ≈ 2.2 IOD, forehead to chin ≈ 3.1 IOD. The skin
 * colour model trims whatever of the ellipse lands on hair or background.
 */
function fromKeypoints(kp: readonly Point[]): FaceGeometry | null {
  const [rEye, lEye, nose, mouth] = kp;
  if (!rEye || !lEye || !nose || !mouth || !finite([rEye, lEye, nose, mouth])) return null;
  const iod = dist(rEye, lEye);
  if (!(iod > 0)) return null;
  const across = { x: (lEye.x - rEye.x) / iod, y: (lEye.y - rEye.y) / iod };
  const eyesMid = mid(rEye, lEye);
  let down = { x: -across.y, y: across.x };
  if ((mouth.x - eyesMid.x) * down.x + (mouth.y - eyesMid.y) * down.y < 0)
    down = { x: -down.x, y: -down.y };
  const at = (from: Point, a: number, d: number): Point => ({
    x: from.x + across.x * a * iod + down.x * d * iod,
    y: from.y + across.y * a * iod + down.y * d * iod,
  });

  const width = iod * 2.2;
  const outline = ellipse(at(eyesMid, 0, 0.45), iod * 1.08, iod * 1.55, across, 32);
  const features = [
    ellipse(rEye, iod * 0.3, iod * 0.15, across),
    ellipse(lEye, iod * 0.3, iod * 0.15, across),
    ellipse(at(rEye, -0.04, -0.33), iod * 0.4, iod * 0.11, across),
    ellipse(at(lEye, 0.04, -0.33), iod * 0.4, iod * 0.11, across),
    ellipse(mouth, iod * 0.5, iod * 0.22, across),
    ellipse(at(nose, -0.15, 0.17), iod * 0.09, iod * 0.06, across, 12),
    ellipse(at(nose, 0.15, 0.17), iod * 0.09, iod * 0.06, across, 12),
  ];
  const eyeWidth = iod * 0.46;
  return {
    outline,
    features,
    underEyes: [underEye(rEye, eyeWidth, across, down), underEye(lEye, eyeWidth, across, down)],
    width,
    box: boundsOf(outline),
  };
}

/** Null when the points are unusable (too few, not finite, zero size). */
export function faceGeometry(face: DetectedFace): FaceGeometry | null {
  if (face.landmarks && face.landmarks.length >= 468) return fromMesh(face.landmarks);
  if (face.keypoints && face.keypoints.length >= 4) return fromKeypoints(face.keypoints);
  return null;
}
