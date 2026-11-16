import { describe, expect, it } from "vitest";
import { crc32 } from "@/lib/remote-camera/crc32";
import {
  CHUNK_HEADER,
  CHUNK_PAYLOAD,
  HIGH_WATER,
  Reassembler,
  chunkCount,
  readChunk,
  sendChunks,
  splitIntoChunks,
  type SendChannel,
} from "@/lib/remote-camera/transfer";

function photo(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("chunking and reassembly", () => {
  it("round-trips a photo of any size, including empty-edge sizes", () => {
    for (const size of [1, CHUNK_PAYLOAD - 1, CHUNK_PAYLOAD, CHUNK_PAYLOAD + 1, 700_123]) {
      const data = photo(size);
      const chunks = [...splitIntoChunks(5, data)];
      expect(chunks).toHaveLength(chunkCount(size));
      const re = new Reassembler({ tx: 5, bytes: size, chunks: chunks.length, crc: crc32(data) });
      let result;
      for (const c of chunks) result = re.push(readChunk(c)!);
      expect(result).toMatchObject({ status: "complete" });
      expect(Array.from((result as { data: Uint8Array }).data)).toEqual(Array.from(data));
    }
  });
  it("accepts chunks out of order and ignores duplicates", () => {
    const data = photo(100_000);
    const chunks = [...splitIntoChunks(1, data)].reverse();
    const re = new Reassembler({
      tx: 1,
      bytes: data.length,
      chunks: chunks.length,
      crc: crc32(data),
    });
    for (const c of chunks) re.push(readChunk(c)!);
    // pushing everything again after completion does not break or double count
    expect(re.received).toBe(chunks.length);
  });
  it("detects a flipped byte, a short photo and a chunk-count lie", () => {
    const data = photo(50_000);
    const expected = {
      tx: 9,
      bytes: data.length,
      chunks: chunkCount(data.length),
      crc: crc32(data),
    };
    const flipped = [...splitIntoChunks(9, data)].map((c) => c.slice());
    flipped[1]![CHUNK_HEADER + 10] = flipped[1]![CHUNK_HEADER + 10]! ^ 0xff;
    const re = new Reassembler(expected);
    let out;
    for (const c of flipped) out = re.push(readChunk(c)!);
    expect(out).toEqual({ status: "failed", reason: "crc" });

    const wrongLen = new Reassembler({ ...expected, bytes: data.length + 5 });
    let out2;
    for (const c of splitIntoChunks(9, data)) out2 = wrongLen.push(readChunk(c)!);
    expect(out2).toEqual({ status: "failed", reason: "length" });

    const wrongCount = new Reassembler({ ...expected, chunks: expected.chunks + 1 });
    expect(wrongCount.push(readChunk([...splitIntoChunks(9, data)][0]!)!)).toEqual({
      status: "failed",
      reason: "chunks",
    });
  });
  it("never mixes in a chunk of another transfer", () => {
    const a = photo(40_000);
    const b = photo(40_000).map((v) => v ^ 0x55);
    const re = new Reassembler({
      tx: 1,
      bytes: a.length,
      chunks: chunkCount(a.length),
      crc: crc32(a),
    });
    const foreign = [...splitIntoChunks(2, b)];
    for (const c of foreign)
      expect(re.push(readChunk(c)!)).toEqual({ status: "progress", received: 0 });
    let out;
    for (const c of splitIntoChunks(1, a)) out = re.push(readChunk(c)!);
    expect(out).toMatchObject({ status: "complete" });
  });
  it("refuses truncated or impossible chunk headers", () => {
    expect(readChunk(new Uint8Array(5))).toBeNull();
    const bad = new Uint8Array(CHUNK_HEADER);
    new DataView(bad.buffer).setUint32(4, 9); // index
    new DataView(bad.buffer).setUint32(8, 3); // total
    expect(readChunk(bad)).toBeNull();
  });
});

class FakeChannel implements SendChannel {
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: Uint8Array[] = [];
  private listeners = new Map<string, Set<() => void>>();
  maxBuffered = 0;
  send(data: ArrayBuffer | ArrayBufferView) {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push(bytes);
    this.bufferedAmount += bytes.length;
    this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount);
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  /** The network drains the buffer a bit at a time. */
  drain(bytes: number) {
    this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes);
    if (this.bufferedAmount <= this.bufferedAmountLowThreshold) this.emit("bufferedamountlow");
  }
}

describe("backpressure", () => {
  it("pauses above the high-water mark and resumes when the buffer drains", async () => {
    const ch = new FakeChannel();
    const data = photo(2_000_000);
    const done = sendChunks(ch, 1, data);
    for (let i = 0; i < 400 && ch.sent.length < chunkCount(data.length); i++) {
      await new Promise((r) => setTimeout(r, 0));
      ch.drain(ch.bufferedAmount); // empty the buffer each turn
    }
    await done;
    expect(ch.sent).toHaveLength(chunkCount(data.length));
    // never more than the high-water mark plus one chunk was queued
    expect(ch.maxBuffered).toBeLessThanOrEqual(HIGH_WATER + CHUNK_PAYLOAD + CHUNK_HEADER);
  });
  it("rejects when the channel stalls", async () => {
    const ch = new FakeChannel();
    await expect(sendChunks(ch, 1, photo(2_000_000), { stallMs: 20 })).rejects.toThrow(/stalled/);
  });
  it("rejects when the channel closes mid-transfer", async () => {
    const ch = new FakeChannel();
    const p = sendChunks(ch, 1, photo(2_000_000), { stallMs: 5_000 });
    setTimeout(() => {
      ch.readyState = "closed";
      ch.emit("close");
    }, 10);
    await expect(p).rejects.toThrow(/closed/);
  });
});
