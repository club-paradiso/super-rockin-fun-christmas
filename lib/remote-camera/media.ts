/**
 * Decode a JPEG blob for drawing. createImageBitmap where the browser has it (iPadOS 15.0+),
 * otherwise an <img>. The caller must call `release()` when it is done.
 */
export interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

export async function decodeJpeg(blob: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close?.(),
      };
    } catch {
      // fall through to <img>: some older WebKit builds reject Blob input
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/** Short random id without crypto.randomUUID (missing on non-secure origins and old Safari). */
export function shortId(prefix = ""): string {
  const bytes = new Uint8Array(12);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = "";
  for (const b of bytes) out += b.toString(36).padStart(2, "0");
  return `${prefix}${out}`;
}
