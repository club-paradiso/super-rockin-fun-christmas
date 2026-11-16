import { describe, expect, it, vi } from "vitest";
import { BoothSound, MUTE_KEY, type AudioContextLike } from "@/lib/kiosk/sound";

/** A recording stand-in for AudioContext: counts the nodes a sound creates. */
function fakeContext(state: AudioContextState = "suspended") {
  const created: string[] = [];
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  });
  const node = (kind: string) => {
    created.push(kind);
    const n = {
      connect: vi.fn(() => n),
      start: vi.fn(),
      stop: vi.fn(),
      gain: param(),
      frequency: param(),
      Q: param(),
      type: "",
      buffer: null as unknown,
    };
    return n;
  };
  const ctx = {
    state,
    currentTime: 0,
    sampleRate: 8000,
    destination: {},
    resume: vi.fn(async () => {
      ctx.state = "running";
    }),
    createOscillator: () => node("osc"),
    createGain: () => node("gain"),
    createBiquadFilter: () => node("filter"),
    createBufferSource: () => node("noise"),
    createBuffer: (_c: number, length: number) => ({
      getChannelData: () => new Float32Array(length),
    }),
  };
  return { ctx: ctx as unknown as AudioContextLike & { state: AudioContextState }, created };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => void (data[k] = v),
  };
}

describe("booth sound (Web Audio, no files)", () => {
  it("stays silent until a touch unlocks it, then plays", async () => {
    const { ctx, created } = fakeContext();
    const sound = new BoothSound({ createContext: () => ctx, storage: null });
    sound.play("shutter");
    expect(created).toHaveLength(0);
    sound.unlock();
    await vi.waitFor(() => expect(sound.ready).toBe(true));
    sound.play("shutter");
    expect(created.filter((k) => k === "noise").length).toBeGreaterThanOrEqual(3);
  });

  it("makes no sound while muted, and remembers the choice on the device", async () => {
    const storage = memoryStorage();
    const { ctx, created } = fakeContext("running");
    const sound = new BoothSound({ createContext: () => ctx, storage });
    sound.unlock();
    const heard = vi.fn();
    sound.subscribe(heard);
    sound.setMuted(true);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(storage.data[MUTE_KEY]).toBe("1");
    for (const name of ["tick", "tickFinal", "shutter", "develop", "stamp", "press"] as const)
      sound.play(name);
    expect(created).toHaveLength(0);
    expect(new BoothSound({ createContext: () => ctx, storage }).isMuted()).toBe(true);
  });

  it("never throws: no Web Audio, a failing context, a broken storage", () => {
    const none = new BoothSound({ createContext: () => null, storage: null });
    none.unlock();
    expect(() => none.play("shutter")).not.toThrow();
    const failing = new BoothSound({
      createContext: () => {
        throw new Error("no audio");
      },
      storage: {
        getItem: () => {
          throw new Error("private mode");
        },
        setItem: () => {
          throw new Error("private mode");
        },
      },
    });
    expect(() => failing.unlock()).not.toThrow();
    expect(() => failing.setMuted(true)).not.toThrow();
    expect(failing.isMuted()).toBe(true);
  });

  it("only plays: the module never asks for a microphone (D72)", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/kiosk/sound.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).not.toMatch(/getUserMedia|MediaRecorder|createMediaStreamSource/);
  });
});
