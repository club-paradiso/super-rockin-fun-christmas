import { FRAMES, getFrame } from "@/config/frames";
import type { FrameDefinition } from "@/lib/compositor/types";

/**
 * "내 사진으로 참여하기" (D66, D93): a guest scans a QR on the booth, picks one to six photos on
 * their own phone, puts them in one of the booth's frames and sends that one picture to the
 * media-wall review queue. Change limits here, not inside routes or components.
 */
export const MOBILE_UPLOAD_CONFIG = {
  /**
   * A plain phone photo with no frame (before D93, and a page cached from then). It is not a booth
   * frame; the wall hangs these as a card, and staff see "휴대폰 사진". A framed phone photo is
   * stored as `phone-<booth frame id>` instead (`mobileFrameId`). Both match the database rule
   * `frame_id ~ '^[a-z0-9-]{1,64}$'`.
   */
  frameId: "phone-photo",
  /** Every stored phone photo has a frame id starting with this (no booth frame does). */
  frameIdPrefix: "phone-",
  /** How many photos a guest may put in one frame: the booth's frames hold 1 to 6. */
  maxPhotos: 6,
  /**
   * How long a QR stays usable after the booth shows it. Long enough to choose a photo and read
   * the consent text, short enough that a photographed QR is useless by the time it is shared.
   */
  tokenTtlMinutes: 15,
  /** One photo per QR: the photo's session id is the QR's id, which is unique in storage. */
  photosPerQr: 1,
  /**
   * A plain photo (no frame): the phone shrinks it to this long edge and re-encodes it as JPEG
   * before sending, so the request stays far below Vercel's 4.5 MB body limit on cellular data.
   * The server re-encodes again (EXIF and GPS removed) to the same bound.
   */
  longEdge: 2048,
  /**
   * Each picked photo is shrunk to this long edge as soon as it is decoded, so six 12-megapixel
   * photos never sit in a phone's memory at once. Larger than any slot at the saved 2× size.
   */
  sourceLongEdge: 1600,
  /**
   * A framed picture is composed at the booth's saved size (KIOSK_CONFIG.outputScale, at most
   * 1200 × 3600 for a strip); the server keeps it at that size instead of shrinking it to the
   * plain-photo bound.
   */
  framedLongEdge: 3600,
  clientJpegQuality: 0.86,
  serverJpegQuality: 85,
  /** Server refuses anything larger than this before decoding (bytes). */
  maxBytes: 4 * 1024 * 1024,
  /** Decoding limit: refuse images with more pixels than this (decompression bombs). */
  maxInputPixels: 50_000_000,
  /** Smaller than this on the short side is not a photo anyone could see on the LED. */
  minShortEdge: 240,
  /** Booth screen: how often it asks whether the phone has sent the photo. */
  statusPollSeconds: 3,
} as const;

export const MOBILE_FRAME_ID = MOBILE_UPLOAD_CONFIG.frameId;
const PREFIX = MOBILE_UPLOAD_CONFIG.frameIdPrefix;

/** True for a photo that came from a guest's phone rather than the booth camera. */
export function isMobilePhoto(row: { frameId: string }): boolean {
  return row.frameId.startsWith(PREFIX);
}

/** The stored frame id of a phone photo composed in this booth frame (D93). */
export function mobileFrameId(boothFrameId: string): string {
  return `${PREFIX}${boothFrameId}`;
}

/**
 * The booth frame a phone photo was composed in, or null for a plain phone photo (no frame) and
 * for anything that is not a phone photo. Only current booth frames count.
 */
export function mobileBoothFrame(frameId: string): FrameDefinition | null {
  if (!frameId.startsWith(PREFIX) || frameId === MOBILE_FRAME_ID) return null;
  const id = frameId.slice(PREFIX.length);
  return FRAMES.find((f) => f.id === id) ?? null;
}

/** A frame id a phone photo may be stored with: the plain one or `phone-<current booth frame>`. */
export function isMobileFrameId(frameId: string): boolean {
  return frameId === MOBILE_FRAME_ID || mobileBoothFrame(frameId) !== null;
}

/** The booth frames a guest can choose on the phone for this many photos (picker order). */
export function mobileFramesFor(count: number): FrameDefinition[] {
  return FRAMES.filter((f) => f.slots.length === count);
}

/** The frame a phone photo hangs in on the wall and is labelled with for staff. */
export function framedPhotoFrame(frameId: string): FrameDefinition {
  return mobileBoothFrame(frameId) ?? getFrame(frameId);
}

export type PhotoSource = "booth" | "mobile";
export const photoSource = (row: { frameId: string }): PhotoSource =>
  isMobilePhoto(row) ? "mobile" : "booth";
