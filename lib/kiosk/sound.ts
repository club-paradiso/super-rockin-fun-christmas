/**
 * Booth sounds, synthesised with the Web Audio API: no audio files, so they work on an offline
 * tablet and add nothing to download. Sounds are feedback only. Nothing in the photo flow waits
 * for them, and a browser without Web Audio (or one that never unlocks it) simply stays silent.
 *
 * This module only ever PLAYS sound. It never asks for the microphone and never records (D72).
 *
 * iOS Safari starts an AudioContext "suspended" and only lets a page resume it inside a user
 * gesture, so the booth calls `unlock()` from the first touch. Staff or a guest can mute the
 * booth; the choice is kept on the device (localStorage) so a muted booth stays muted after a
 * reload.
 */

export type BoothSoundName = "tick" | "tickFinal" | "shutter" | "develop" | "stamp" | "press";

/** The part of AudioContext the sounds use (a fake in tests). */
export type AudioContextLike = Pick<
  AudioContext,
  | "currentTime"
  | "destination"
  | "state"
  | "resume"
  | "sampleRate"
  | "createOscillator"
  | "createGain"
  | "createBufferSource"
  | "createBuffer"
  | "createBiquadFilter"
>;

export interface BoothSoundOptions {
  /** Makes the context; null when the browser has no Web Audio. */
  createContext?: () => AudioContextLike | null;
  /** Where the mute choice is kept; null = not kept (private mode, tests). */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

export const MUTE_KEY = "ftl.boothMuted";
/** Overall level. The booth stands in a hall; this is a click, not a speaker announcement. */
const MASTER = 0.55;

function browserContext(): AudioContextLike | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export class BoothSound {
  private ctx: AudioContextLike | null = null;
  private triedContext = false;
  private muted: boolean;
  private noise: AudioBuffer | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly createContext: () => AudioContextLike | null;
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;

  constructor(options: BoothSoundOptions = {}) {
    this.createContext = options.createContext ?? browserContext;
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    let stored: string | null = null;
    try {
      stored = this.storage?.getItem(MUTE_KEY) ?? null;
    } catch {}
    this.muted = stored === "1";
  }

  /** Call from a user gesture (the first touch). Safe to call again; never throws. */
  unlock(): void {
    const ctx = this.context();
    if (ctx && ctx.state !== "running") {
      void Promise.resolve()
        .then(() => ctx.resume())
        .catch(() => undefined);
    }
  }

  /** True once the browser lets the booth make a sound. */
  get ready(): boolean {
    return this.ctx?.state === "running";
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    try {
      this.storage?.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch {}
    for (const listener of this.listeners) listener();
  }

  /** For useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Plays one sound now. Muted, locked or unsupported: nothing happens. Never throws. */
  play(name: BoothSoundName): void {
    if (this.muted) return;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    try {
      const t = ctx.currentTime + 0.005;
      switch (name) {
        case "tick":
          return this.click(ctx, t, 1850, 0.05, 0.22);
        case "tickFinal":
          return this.click(ctx, t, 2450, 0.07, 0.3);
        case "press":
          return this.thud(ctx, t, 140, 0.06, 0.35);
        case "shutter":
          return this.shutter(ctx, t);
        case "develop":
          return this.develop(ctx, t);
        case "stamp":
          this.thud(ctx, t, 90, 0.16, 0.6);
          return this.burst(ctx, t, 0.05, 900, 0.25);
      }
    } catch {
      // A sound is never worth a broken booth.
    }
  }

  private context(): AudioContextLike | null {
    if (!this.triedContext) {
      this.triedContext = true;
      try {
        this.ctx = this.createContext();
      } catch {
        this.ctx = null;
      }
    }
    return this.ctx;
  }

  private out(ctx: AudioContextLike, level: number): GainNode {
    const gain = ctx.createGain();
    gain.gain.value = level * MASTER;
    gain.connect(ctx.destination);
    return gain;
  }

  /** A short decaying tone: a clock tick. */
  private click(ctx: AudioContextLike, t: number, freq: number, length: number, level: number) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + length);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(1, t + 0.003);
    env.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(env).connect(this.out(ctx, level));
    osc.start(t);
    osc.stop(t + length + 0.02);
  }

  /** A low body knock (a key going down, a rubber stamp). */
  private thud(ctx: AudioContextLike, t: number, freq: number, length: number, level: number) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq * 1.8, t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + length * 0.6);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(1, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(env).connect(this.out(ctx, level));
    osc.start(t);
    osc.stop(t + length + 0.02);
  }

  /** Filtered white noise: the metal and spring of a shutter, the teeth of a winder. */
  private burst(ctx: AudioContextLike, t: number, length: number, freq: number, level: number) {
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = freq;
    filter.Q.value = 0.9;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(1, t + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, t + length);
    src.connect(filter).connect(env).connect(this.out(ctx, level));
    src.start(t);
    src.stop(t + length + 0.02);
  }

  /**
   * A mechanical film camera: the mirror slap and the curtain (two sharp clicks), then the
   * winding lever ratcheting the film on.
   */
  private shutter(ctx: AudioContextLike, t: number) {
    this.burst(ctx, t, 0.035, 3200, 0.9);
    this.thud(ctx, t, 180, 0.05, 0.45);
    this.burst(ctx, t + 0.075, 0.03, 2400, 0.7);
    const teeth = 7;
    for (let i = 0; i < teeth; i++) {
      const at = t + 0.24 + i * 0.045;
      this.burst(ctx, at, 0.018, 1500 + (i % 2) * 400, 0.32);
    }
  }

  /** The print is ready: two soft rising notes, quieter than anything else. */
  private develop(ctx: AudioContextLike, t: number) {
    for (const [i, freq] of [659.25, 987.77].entries()) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      const at = t + i * 0.16;
      osc.type = "sine";
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0.0001, at);
      env.gain.exponentialRampToValueAtTime(1, at + 0.02);
      env.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
      osc.connect(env).connect(this.out(ctx, 0.12));
      osc.start(at);
      osc.stop(at + 0.95);
    }
  }

  private noiseBuffer(ctx: AudioContextLike): AudioBuffer {
    if (this.noise) return this.noise;
    const length = Math.floor(ctx.sampleRate * 0.25);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // A fixed pseudo-random sequence: the same shutter every time.
    let seed = 0x2545f491;
    for (let i = 0; i < length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      data[i] = ((seed >>> 0) / 0xffffffff) * 2 - 1;
    }
    this.noise = buffer;
    return buffer;
  }
}

let shared: BoothSound | null = null;
/** The booth's one sound player (browser only). */
export function boothSound(): BoothSound {
  shared ??= new BoothSound();
  return shared;
}
