/**
 * Session video formats (D72), shared by the booth and every server route. Two containers only:
 * MP4 where the booth's browser can record it (phones play it everywhere), WebM otherwise.
 * Video is silent by construction: the booth never asks for a microphone.
 */
export const VIDEO_MIMES = ["video/mp4", "video/webm"] as const;
export type VideoMime = (typeof VIDEO_MIMES)[number];

/** "video/webm;codecs=vp9" → "video/webm". Null for anything that is not one of ours. */
export function baseVideoMime(type: string | null | undefined): VideoMime | null {
  const base = type?.split(";")[0]?.trim().toLowerCase() ?? "";
  return (VIDEO_MIMES as readonly string[]).includes(base) ? (base as VideoMime) : null;
}

export const videoExt = (mime: VideoMime) => (mime === "video/mp4" ? "mp4" : "webm");

const EBML = [0x1a, 0x45, 0xdf, 0xa3];
const FTYP = [0x66, 0x74, 0x79, 0x70]; // "ftyp"

/**
 * Magic-byte check: WebM starts with the EBML header; MP4 starts with an `ftyp` box (bytes 4–7).
 * It proves the container, not that every frame decodes — enough to refuse anything that is not
 * a video file at all.
 */
export function hasVideoSignature(data: Uint8Array, mime: string): boolean {
  if (mime === "video/webm") return data.length > 4 && EBML.every((b, i) => data[i] === b);
  if (mime === "video/mp4") return data.length > 12 && FTYP.every((b, i) => data[4 + i] === b);
  return false;
}

export type ByteRange =
  { kind: "full" } | { kind: "partial"; start: number; end: number } | { kind: "unsatisfiable" };

/**
 * One HTTP byte range ("bytes=0-1", "bytes=500-", "bytes=-200") against a body of `size` bytes.
 * `end` is inclusive. A missing, malformed or multi-part header means the whole body (RFC 9110
 * lets a server ignore Range); only a well-formed range outside the body is unsatisfiable.
 */
export function parseByteRange(header: string | null, size: number): ByteRange {
  const m = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return { kind: "full" };
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return { kind: "unsatisfiable" };
  return { kind: "partial", start, end };
}
