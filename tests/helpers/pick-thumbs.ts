import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FRAME_CARDS } from "@/config/frames/v2";
import { thumbFingerprintInput } from "@/lib/kiosk/pick-thumbs";

/** Node side of lib/kiosk/pick-thumbs.ts: the fingerprints as the files on disk give them. */
const PUBLIC_DIR = path.resolve(__dirname, "..", "..", "public");

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export function thumbFingerprints(): Record<string, string> {
  const fileHash = (src: string) => sha(readFileSync(path.join(PUBLIC_DIR, src)));
  return Object.fromEntries(
    FRAME_CARDS.map((card) => [card.id, sha(thumbFingerprintInput(card, fileHash))]),
  );
}

export const THUMB_DIR = path.join(PUBLIC_DIR, "kiosk-thumbs");
export const THUMB_MANIFEST = path.join(THUMB_DIR, "manifest.json");
