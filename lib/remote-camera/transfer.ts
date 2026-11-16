import { crc32 } from "./crc32";
import { MAX_PHOTO_BYTES } from "./protocol";

/**
 * Binary photo transfer over a WebRTC data channel. A photo is cut into chunks; each chunk is
 * `[tx u32][index u32][total u32][payload]` (big endian), so chunks of an old transfer can never
 * be mixed into a new one, and a missing or repeated chunk is noticed. The whole photo is checked
 * by length and CRC-32 against the CAPTURE_RESULT message before anyone uses it.
 */
export const CHUNK_PAYLOAD = 16 * 1024 - 12;
export const CHUNK_HEADER = 12;

export function chunkCount(bytes: number, payload = CHUNK_PAYLOAD): number {
  return Math.max(1, Math.ceil(bytes / payload));
}

export function* splitIntoChunks(
  tx: number,
  data: Uint8Array,
  payload = CHUNK_PAYLOAD,
): Generator<Uint8Array> {
  const total = chunkCount(data.length, payload);
  for (let index = 0; index < total; index++) {
    const part = data.subarray(index * payload, Math.min(data.length, (index + 1) * payload));
    const out = new Uint8Array(CHUNK_HEADER + part.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, tx >>> 0);
    view.setUint32(4, index);
    view.setUint32(8, total);
    out.set(part, CHUNK_HEADER);
    yield out;
  }
}

export interface ChunkMeta {
  tx: number;
  index: number;
  total: number;
  payload: Uint8Array;
}

export function readChunk(buffer: ArrayBuffer | Uint8Array): ChunkMeta | null {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < CHUNK_HEADER) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(8);
  const index = view.getUint32(4);
  if (total < 1 || total > MAX_PHOTO_BYTES || index >= total) return null;
  return {
    tx: view.getUint32(0),
    index,
    total,
    payload: bytes.subarray(CHUNK_HEADER),
  };
}

export interface Expected {
  tx: number;
  bytes: number;
  chunks: number;
  crc: number;
}

export type AssembleResult =
  | { status: "progress"; received: number }
  | { status: "complete"; data: Uint8Array }
  | { status: "failed"; reason: "length" | "crc" | "chunks" };

/** Collects the chunks of one photo. Duplicates are ignored; chunks of other transfers are dropped. */
export class Reassembler {
  private parts = new Map<number, Uint8Array>();
  private size = 0;

  constructor(private readonly expected: Expected) {}

  get received(): number {
    return this.parts.size;
  }

  push(chunk: ChunkMeta): AssembleResult {
    const e = this.expected;
    if (chunk.tx !== e.tx) return { status: "progress", received: this.parts.size };
    if (chunk.total !== e.chunks) return { status: "failed", reason: "chunks" };
    if (!this.parts.has(chunk.index)) {
      // Copy: the browser may reuse the buffer it handed us.
      this.parts.set(chunk.index, chunk.payload.slice());
      this.size += chunk.payload.length;
      if (this.size > e.bytes) return { status: "failed", reason: "length" };
    }
    if (this.parts.size < e.chunks) return { status: "progress", received: this.parts.size };
    if (this.size !== e.bytes) return { status: "failed", reason: "length" };
    const data = new Uint8Array(e.bytes);
    let offset = 0;
    for (let i = 0; i < e.chunks; i++) {
      const part = this.parts.get(i);
      if (!part) return { status: "failed", reason: "chunks" };
      data.set(part, offset);
      offset += part.length;
    }
    if (crc32(data) !== e.crc) return { status: "failed", reason: "crc" };
    return { status: "complete", data };
  }
}

/** The minimum of an RTCDataChannel the sender needs, so tests can use a fake. */
export interface SendChannel {
  readonly readyState: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: ArrayBuffer | ArrayBufferView): void;
  addEventListener(type: "bufferedamountlow" | "close", listener: () => void): void;
  removeEventListener(type: "bufferedamountlow" | "close", listener: () => void): void;
}

export const HIGH_WATER = 256 * 1024;
export const LOW_WATER = 64 * 1024;

/**
 * Send every chunk, pausing while the channel's buffer is above HIGH_WATER (backpressure). Rejects
 * if the channel closes or no progress is made for `stallMs`.
 */
export async function sendChunks(
  channel: SendChannel,
  tx: number,
  data: Uint8Array,
  { stallMs = 4_000, payload = CHUNK_PAYLOAD }: { stallMs?: number; payload?: number } = {},
): Promise<void> {
  channel.bufferedAmountLowThreshold = LOW_WATER;
  for (const chunk of splitIntoChunks(tx, data, payload)) {
    if (channel.readyState !== "open") throw new Error("channel closed");
    if (channel.bufferedAmount > HIGH_WATER) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("transfer stalled"));
        }, stallMs);
        const onLow = () => {
          cleanup();
          resolve();
        };
        const onClose = () => {
          cleanup();
          reject(new Error("channel closed"));
        };
        const cleanup = () => {
          clearTimeout(timer);
          channel.removeEventListener("bufferedamountlow", onLow);
          channel.removeEventListener("close", onClose);
        };
        channel.addEventListener("bufferedamountlow", onLow);
        channel.addEventListener("close", onClose);
      });
    }
    channel.send(chunk);
  }
}
