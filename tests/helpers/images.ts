/** Smallest byte strings that pass the server's JPEG/PNG signature checks. */
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
export const JPEG_TRUNCATED = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
export const SESSION = "11111111-2222-4333-8444-555555555555";
export const uuid = () => crypto.randomUUID();

/** Smallest byte strings that pass the server's video container checks (D72). */
export const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42]);
export const MP4 = new Uint8Array([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 1,
]);
