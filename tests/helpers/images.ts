/** Smallest byte strings that pass the server's JPEG/PNG signature checks. */
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
export const JPEG_TRUNCATED = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
export const SESSION = "11111111-2222-4333-8444-555555555555";
export const uuid = () => crypto.randomUUID();
