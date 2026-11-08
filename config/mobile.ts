/**
 * "내 사진으로 참여하기" (D66): a guest scans a QR on the booth and sends one photo from their own
 * phone to the media-wall review queue. Change limits here, not inside routes or components.
 */
export const MOBILE_UPLOAD_CONFIG = {
  /**
   * Phone photos are stored as photos with this frame id. It is not a booth frame (the booth
   * never offers it); the wall hangs these as a card instead of a strip, and staff see
   * "휴대폰 사진". Matches the database rule `frame_id ~ '^[a-z0-9-]{1,64}$'`.
   */
  frameId: "phone-photo",
  /**
   * How long a QR stays usable after the booth shows it. Long enough to choose a photo and read
   * the consent text, short enough that a photographed QR is useless by the time it is shared.
   */
  tokenTtlMinutes: 15,
  /** One photo per QR: the photo's session id is the QR's id, which is unique in storage. */
  photosPerQr: 1,
  /**
   * The phone shrinks the photo to this long edge and re-encodes it as JPEG before sending, so the
   * request stays far below Vercel's 4.5 MB body limit on cellular data. The server re-encodes
   * again (EXIF and GPS removed) to the same bound.
   */
  longEdge: 2048,
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

/** True for a photo that came from a guest's phone rather than the booth camera. */
export function isMobilePhoto(row: { frameId: string }): boolean {
  return row.frameId === MOBILE_FRAME_ID;
}

export type PhotoSource = "booth" | "mobile";
export const photoSource = (row: { frameId: string }): PhotoSource =>
  isMobilePhoto(row) ? "mobile" : "booth";
