import { backoffMs, type SignalFrom, type SignalMessage } from "./protocol";
import type { RtcIceServer } from "./types";

export interface InboundSignal {
  seq: number;
  from: SignalFrom;
  message: SignalMessage;
  /** How old the message was when the server answered (server clock, so no skew). */
  ageMs: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type SignalingError = "unauthorized" | "revoked" | "network" | "rate_limited" | "server";

/**
 * HTTP signaling client for both ends. `base` is "/api/kiosk/camera" (booth) or "/api/camera"
 * (phone). It short-polls the server mailbox: Vercel functions cannot hold a socket open, and
 * polling needs no service beyond the app itself. Messages are applied in order, once.
 */
export class SignalingClient {
  private after = 0;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  iceServers: RtcIceServer[] | null = null;

  constructor(
    private readonly base: string,
    private readonly handlers: {
      onMessage(m: InboundSignal): void;
      onError?(e: SignalingError): void;
    },
    private readonly fetchImpl: FetchLike = (i, init) => fetch(i, init),
    private readonly intervalMs: { fast: number; slow: number } = { fast: 400, slow: 2_000 },
    /**
     * Throw away what is already waiting in the mailbox on the first successful poll. A page that
     * (re)starts must not act on an offer or command from before it started: that connection is
     * long dead.
     */
    private skipBacklog = false,
  ) {}

  private slow = false;

  /** Fast while a connection is being made, slow while idle. */
  setSlow(slow: boolean) {
    this.slow = slow;
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async send(message: SignalMessage): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.base}/signal`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) this.report(res.status);
      return res.ok;
    } catch {
      this.handlers.onError?.("network");
      return false;
    }
  }

  /** One poll right now (also used by the loop). Returns false on error. */
  async pollOnce(): Promise<boolean> {
    try {
      const ice = this.iceServers ? "" : "&ice=1";
      const res = await this.fetchImpl(`${this.base}/signal?after=${this.after}${ice}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!res.ok) {
        this.report(res.status);
        return false;
      }
      const body = (await res.json()) as {
        messages?: Array<Omit<InboundSignal, "ageMs"> & { at?: string }>;
        last?: number;
        now?: string;
        iceServers?: RtcIceServer[];
      };
      if (body.iceServers) this.iceServers = body.iceServers;
      const serverNow = body.now ? Date.parse(body.now) : NaN;
      const skip = this.skipBacklog;
      this.skipBacklog = false;
      for (const m of body.messages ?? []) {
        if (m.seq <= this.after) continue;
        this.after = m.seq;
        if (skip) continue;
        const sent = m.at ? Date.parse(m.at) : NaN;
        this.handlers.onMessage({
          seq: m.seq,
          from: m.from,
          message: m.message,
          ageMs:
            Number.isFinite(serverNow) && Number.isFinite(sent) ? Math.max(0, serverNow - sent) : 0,
        });
      }
      if (typeof body.last === "number" && body.last > this.after) this.after = body.last;
      this.failures = 0;
      return true;
    } catch {
      this.handlers.onError?.("network");
      return false;
    }
  }

  private report(status: number) {
    const e: SignalingError =
      status === 401 || status === 403
        ? "unauthorized"
        : status === 429
          ? "rate_limited"
          : status === 404
            ? "unauthorized"
            : "server";
    this.handlers.onError?.(e);
  }

  private async tick() {
    if (!this.running) return;
    const ok = await this.pollOnce();
    if (!this.running) return;
    this.failures = ok ? 0 : this.failures + 1;
    const wait = ok
      ? this.slow
        ? this.intervalMs.slow
        : this.intervalMs.fast
      : backoffMs(this.failures, 1_000, 10_000);
    this.timer = setTimeout(() => void this.tick(), wait);
  }
}
