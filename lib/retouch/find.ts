import { RETOUCH_CONFIG, type RetouchConfig } from "@/config/retouch";
import { get2d, type CanvasFactory, type CanvasLike } from "@/lib/canvas";
import type { FaceFinder } from "./detector";
import { faceGeometry } from "./geometry";
import type { DetectedFace, Rect } from "./types";

/**
 * Every face of a photo: the finder's own pass over the whole photo, then (config `tileGrid`)
 * the six-point detector over overlapping tiles, for the faces too small for the first pass.
 * A group photo must not come out with some faces retouched and their neighbours not.
 */

/** The tiles, in photo pixels: `grid` × `grid`, each `size` of the photo, evenly spread. */
export function tileRects(width: number, height: number, grid: number, size: number): Rect[] {
  if (!(grid > 1) || !(size > 0) || size >= 1) return [];
  const w = Math.round(width * size);
  const h = Math.round(height * size);
  const out: Rect[] = [];
  for (let row = 0; row < grid; row++)
    for (let col = 0; col < grid; col++)
      out.push({
        x: Math.round(((width - w) * col) / (grid - 1)),
        y: Math.round(((height - h) * row) / (grid - 1)),
        width: w,
        height: h,
      });
  return out;
}

const centre = (box: Rect) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const holds = (box: Rect, p: { x: number; y: number }) =>
  p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;

/** The same face twice: either one's centre lies inside the other's outline box. */
function sameFace(a: Rect, b: Rect): boolean {
  return holds(a, centre(b)) || holds(b, centre(a));
}

export function findFaces(
  finder: FaceFinder,
  photo: CanvasLike,
  width: number,
  height: number,
  createCanvas: CanvasFactory,
  config: RetouchConfig = RETOUCH_CONFIG,
): DetectedFace[] {
  const faces = finder.detect(photo, width, height);
  const { tileGrid, tileSize } = config.detection;
  const tiles = finder.detectPoints ? tileRects(width, height, tileGrid, tileSize) : [];
  if (tiles.length === 0) return faces;

  const boxes: Rect[] = [];
  for (const face of faces) {
    const g = faceGeometry(face);
    if (g) boxes.push(g.box);
  }
  const tile = createCanvas(tiles[0]!.width, tiles[0]!.height);
  try {
    const ctx = get2d(tile);
    for (const rect of tiles) {
      ctx.drawImage(
        photo as unknown as CanvasImageSource,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        0,
        0,
        rect.width,
        rect.height,
      );
      for (const found of finder.detectPoints!(tile, rect.width, rect.height)) {
        const face: DetectedFace = {
          keypoints: found.keypoints!.map((p) => ({ x: p.x + rect.x, y: p.y + rect.y })),
          score: found.score,
        };
        const g = faceGeometry(face);
        if (!g) continue;
        // A face cut by an inner edge of this tile is whole in the next one: take it there.
        const cut =
          (g.box.x < rect.x && rect.x > 0) ||
          (g.box.y < rect.y && rect.y > 0) ||
          (g.box.x + g.box.width > rect.x + rect.width && rect.x + rect.width < width) ||
          (g.box.y + g.box.height > rect.y + rect.height && rect.y + rect.height < height);
        if (cut || boxes.some((box) => sameFace(box, g.box))) continue;
        boxes.push(g.box);
        faces.push(face);
      }
    }
  } finally {
    tile.width = tile.height = 0;
  }
  return faces;
}
