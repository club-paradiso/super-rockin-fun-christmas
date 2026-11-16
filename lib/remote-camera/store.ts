import type { CameraReport, SignalFrom, SignalMessage, SignalTo } from "./protocol";
import { EMPTY_REPORT, TIMING } from "./protocol";

/**
 * Server-side state of Remote Camera: pairing codes, paired cameras and the signaling mailbox.
 * Holds no photographs and no video. One implementation per deployment kind:
 *  - MemoryRemoteCameraStore: hub and development (one long-running Node process).
 *  - SupabaseRemoteCameraStore: Vercel, where instances do not share memory.
 */
export interface Pairing {
  id: string;
  kioskId: string;
  name: string;
  createdAt: string;
  pairedBy: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  report: CameraReport;
}

export interface MailboxMessage {
  seq: number;
  from: SignalFrom;
  to: SignalTo;
  at: string;
  message: SignalMessage;
}

export interface IssuedCode {
  expiresAt: string;
}

export interface RemoteCameraStore {
  readonly name: "memory" | "supabase";
  /** Replaces any unused code of this kiosk. `codeHash` is sha256 of the normalized code. */
  issueCode(input: {
    kioskId: string;
    codeHash: string;
    staffId: string;
    nowIso: string;
    expiresAtIso: string;
  }): Promise<IssuedCode>;
  /**
   * Atomic and single use: the code must exist, be unused and unexpired. Creates the pairing and
   * revokes the kiosk's previous one. Null for unknown, used or expired (indistinguishable).
   */
  consumeCode(input: {
    codeHash: string;
    pairingId: string;
    name: string;
    nowIso: string;
  }): Promise<Pairing | null>;
  get(pairingId: string): Promise<Pairing | null>;
  activeForKiosk(kioskId: string): Promise<Pairing | null>;
  list(): Promise<Pairing[]>;
  /** False when already revoked or unknown. */
  revoke(pairingId: string, staffId: string, nowIso: string): Promise<boolean>;
  /** Liveness. Cheap: implementations may skip a write when `lastSeenAt` is recent. */
  touch(pairingId: string, nowIso: string): Promise<void>;
  setReport(pairingId: string, report: CameraReport, nowIso: string): Promise<void>;
  push(input: {
    pairingId: string;
    kioskId: string;
    from: SignalFrom;
    to: SignalTo;
    message: SignalMessage;
    nowIso: string;
  }): Promise<number>;
  poll(input: {
    pairingId: string;
    to: SignalTo;
    afterSeq: number;
    nowIso: string;
    limit?: number;
  }): Promise<MailboxMessage[]>;
  /** Deletes expired codes and old messages. */
  purge(nowIso: string): Promise<void>;
}

export function isOnline(p: Pairing | null, nowMs: number): boolean {
  if (!p || p.revokedAt || !p.lastSeenAt) return false;
  return nowMs - Date.parse(p.lastSeenAt) <= TIMING.onlineWithinMs;
}

/** A thumbnail from a staff test is shown for two minutes, then it is gone. */
export function withFreshThumb(report: CameraReport, nowMs: number): CameraReport {
  if (!report.testThumb) return report;
  const at = report.testAt ? Date.parse(report.testAt) : NaN;
  return Number.isFinite(at) && nowMs - at < 120_000
    ? report
    : { ...report, testThumb: null, testAt: null };
}

const MAX_MESSAGES_PER_PAIRING = 300;

/** In-memory implementation. Also the reference the Supabase one is held to. */
export class MemoryRemoteCameraStore implements RemoteCameraStore {
  readonly name = "memory" as const;
  private codes = new Map<
    string,
    { kioskId: string; staffId: string; expiresAt: number; used: boolean }
  >();
  private pairings = new Map<string, Pairing>();
  private mailbox: MailboxMessage[] = [];
  private seq = 0;
  private byPairing = new Map<number, string>();

  async issueCode(input: {
    kioskId: string;
    codeHash: string;
    staffId: string;
    nowIso: string;
    expiresAtIso: string;
  }): Promise<IssuedCode> {
    for (const [hash, c] of this.codes)
      if (c.kioskId === input.kioskId && !c.used) this.codes.delete(hash);
    this.codes.set(input.codeHash, {
      kioskId: input.kioskId,
      staffId: input.staffId,
      expiresAt: Date.parse(input.expiresAtIso),
      used: false,
    });
    return { expiresAt: input.expiresAtIso };
  }

  async consumeCode(input: {
    codeHash: string;
    pairingId: string;
    name: string;
    nowIso: string;
  }): Promise<Pairing | null> {
    const code = this.codes.get(input.codeHash);
    const now = Date.parse(input.nowIso);
    if (!code || code.used || code.expiresAt <= now) return null;
    code.used = true;
    for (const p of this.pairings.values()) {
      if (p.kioskId === code.kioskId && !p.revokedAt) {
        p.revokedAt = input.nowIso;
        p.revokedBy = "replaced";
      }
    }
    const pairing: Pairing = {
      id: input.pairingId,
      kioskId: code.kioskId,
      name: input.name,
      createdAt: input.nowIso,
      pairedBy: code.staffId,
      lastSeenAt: input.nowIso,
      revokedAt: null,
      revokedBy: null,
      report: { ...EMPTY_REPORT, state: "idle" },
    };
    this.pairings.set(pairing.id, pairing);
    return { ...pairing };
  }

  async get(pairingId: string): Promise<Pairing | null> {
    const p = this.pairings.get(pairingId);
    return p ? { ...p } : null;
  }

  async activeForKiosk(kioskId: string): Promise<Pairing | null> {
    for (const p of this.pairings.values())
      if (p.kioskId === kioskId && !p.revokedAt) return { ...p };
    return null;
  }

  async list(): Promise<Pairing[]> {
    return [...this.pairings.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50)
      .map((p) => ({ ...p }));
  }

  async revoke(pairingId: string, staffId: string, nowIso: string): Promise<boolean> {
    const p = this.pairings.get(pairingId);
    if (!p || p.revokedAt) return false;
    p.revokedAt = nowIso;
    p.revokedBy = staffId;
    p.report = { ...p.report, state: "offline" };
    this.mailbox = this.mailbox.filter((m) => this.byPairing.get(m.seq) !== pairingId);
    return true;
  }

  async touch(pairingId: string, nowIso: string): Promise<void> {
    const p = this.pairings.get(pairingId);
    if (p && !p.revokedAt) p.lastSeenAt = nowIso;
  }

  async setReport(pairingId: string, report: CameraReport, nowIso: string): Promise<void> {
    const p = this.pairings.get(pairingId);
    if (!p || p.revokedAt) return;
    p.report = report;
    p.lastSeenAt = nowIso;
  }

  async push(input: {
    pairingId: string;
    kioskId: string;
    from: SignalFrom;
    to: SignalTo;
    message: SignalMessage;
    nowIso: string;
  }): Promise<number> {
    const seq = ++this.seq;
    this.mailbox.push({
      seq,
      from: input.from,
      to: input.to,
      at: input.nowIso,
      message: input.message,
    });
    this.byPairing.set(seq, input.pairingId);
    // Bounded: a runaway client can never grow the mailbox without limit.
    const mine = this.mailbox.filter((m) => this.byPairing.get(m.seq) === input.pairingId);
    if (mine.length > MAX_MESSAGES_PER_PAIRING) {
      const drop = new Set(mine.slice(0, mine.length - MAX_MESSAGES_PER_PAIRING).map((m) => m.seq));
      this.mailbox = this.mailbox.filter((m) => !drop.has(m.seq));
      for (const s of drop) this.byPairing.delete(s);
    }
    return seq;
  }

  async poll(input: {
    pairingId: string;
    to: SignalTo;
    afterSeq: number;
    nowIso: string;
    limit?: number;
  }): Promise<MailboxMessage[]> {
    const cutoff = Date.parse(input.nowIso) - TIMING.signalTtlMs;
    return this.mailbox
      .filter(
        (m) =>
          m.seq > input.afterSeq &&
          m.to === input.to &&
          this.byPairing.get(m.seq) === input.pairingId &&
          Date.parse(m.at) >= cutoff,
      )
      .slice(0, input.limit ?? 50);
  }

  async purge(nowIso: string): Promise<void> {
    const now = Date.parse(nowIso);
    for (const [hash, c] of this.codes) if (c.used || c.expiresAt <= now) this.codes.delete(hash);
    const cutoff = now - TIMING.signalTtlMs;
    this.mailbox = this.mailbox.filter((m) => Date.parse(m.at) >= cutoff);
    const live = new Set(this.mailbox.map((m) => m.seq));
    for (const seq of this.byPairing.keys()) if (!live.has(seq)) this.byPairing.delete(seq);
  }
}
