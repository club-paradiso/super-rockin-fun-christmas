import { createHash, randomInt } from "node:crypto";
import { PAIRING_ALPHABET, PAIRING_CODE_LENGTH } from "./protocol";

/** A fresh pairing code from a CSPRNG: 31^8 ≈ 8.5e11 possibilities, valid once, for minutes. */
export function newPairingCode(): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++)
    code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  return code;
}

/** Only this hash is stored. The code itself lives on the staff screen and in the QR. */
export function hashPairingCode(code: string): string {
  return createHash("sha256").update(`ftl-camera-pair-v1:${code}`).digest("hex");
}
