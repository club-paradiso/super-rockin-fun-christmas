import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SignalFrom, SignalMessage, SignalTo } from "./protocol";
import { EMPTY_REPORT, TIMING, parseReport } from "./protocol";
import type { IssuedCode, MailboxMessage, Pairing, RemoteCameraStore } from "./store";

type Row = Record<string, unknown>;

function fail(what: string, error: { message: string }): never {
  throw new Error(`remote camera: ${what}: ${error.message}`);
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

function toPairing(r: Row): Pairing {
  return {
    id: String(r.id),
    kioskId: String(r.kiosk_id),
    name: String(r.name),
    createdAt: iso(r.created_at)!,
    pairedBy: String(r.paired_by),
    lastSeenAt: iso(r.last_seen_at),
    revokedAt: iso(r.revoked_at),
    revokedBy: (r.revoked_by as string | null) ?? null,
    report: parseReport({ ...EMPTY_REPORT, ...((r.report as object) ?? {}) }) ?? EMPTY_REPORT,
  };
}

/** How recent a `last_seen_at` must be for a touch to be skipped (saves a write per poll). */
const TOUCH_EVERY_MS = 4_000;

/**
 * Supabase implementation (cloud). Written against the same contract as MemoryRemoteCameraStore;
 * the contract test in tests/unit/remote-camera-store.test.ts runs the memory store, and
 * tests/integration runs this one when a Supabase stack is available (npm run test:supabase).
 */
export class SupabaseRemoteCameraStore implements RemoteCameraStore {
  readonly name = "supabase" as const;
  constructor(private readonly db: SupabaseClient) {}

  async issueCode(input: {
    kioskId: string;
    codeHash: string;
    staffId: string;
    nowIso: string;
    expiresAtIso: string;
  }): Promise<IssuedCode> {
    const del = await this.db
      .from("remote_camera_codes")
      .delete()
      .eq("kiosk_id", input.kioskId)
      .is("used_at", null);
    if (del.error) fail("clear codes", del.error);
    const ins = await this.db.from("remote_camera_codes").insert({
      code_hash: input.codeHash,
      kiosk_id: input.kioskId,
      created_by: input.staffId,
      created_at: input.nowIso,
      expires_at: input.expiresAtIso,
    });
    if (ins.error) fail("issue code", ins.error);
    return { expiresAt: input.expiresAtIso };
  }

  async consumeCode(input: {
    codeHash: string;
    pairingId: string;
    name: string;
    nowIso: string;
  }): Promise<Pairing | null> {
    const { data, error } = await this.db.rpc("ftl_camera_consume_code", {
      p_code_hash: input.codeHash,
      p_pairing_id: input.pairingId,
      p_name: input.name,
      p_now: input.nowIso,
    });
    if (error) fail("consume code", error);
    const rows = (data ?? []) as Row[];
    return rows[0] ? toPairing(rows[0]) : null;
  }

  async get(pairingId: string): Promise<Pairing | null> {
    const { data, error } = await this.db
      .from("remote_camera_pairings")
      .select("*")
      .eq("id", pairingId)
      .maybeSingle();
    if (error) fail("get", error);
    return data ? toPairing(data as Row) : null;
  }

  async activeForKiosk(kioskId: string): Promise<Pairing | null> {
    const { data, error } = await this.db
      .from("remote_camera_pairings")
      .select("*")
      .eq("kiosk_id", kioskId)
      .is("revoked_at", null)
      .maybeSingle();
    if (error) fail("active", error);
    return data ? toPairing(data as Row) : null;
  }

  async list(): Promise<Pairing[]> {
    const { data, error } = await this.db
      .from("remote_camera_pairings")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) fail("list", error);
    return ((data ?? []) as Row[]).map(toPairing);
  }

  async revoke(pairingId: string, staffId: string, nowIso: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("remote_camera_pairings")
      .update({ revoked_at: nowIso, revoked_by: staffId })
      .eq("id", pairingId)
      .is("revoked_at", null)
      .select("id");
    if (error) fail("revoke", error);
    return (data ?? []).length > 0;
  }

  async touch(pairingId: string, nowIso: string): Promise<void> {
    const cutoff = new Date(Date.parse(nowIso) - TOUCH_EVERY_MS).toISOString();
    const { error } = await this.db
      .from("remote_camera_pairings")
      .update({ last_seen_at: nowIso })
      .eq("id", pairingId)
      .is("revoked_at", null)
      .or(`last_seen_at.is.null,last_seen_at.lt.${cutoff}`);
    if (error) fail("touch", error);
  }

  async setReport(pairingId: string, report: unknown, nowIso: string): Promise<void> {
    const { error } = await this.db
      .from("remote_camera_pairings")
      .update({ report, last_seen_at: nowIso })
      .eq("id", pairingId)
      .is("revoked_at", null);
    if (error) fail("report", error);
  }

  async push(input: {
    pairingId: string;
    kioskId: string;
    from: SignalFrom;
    to: SignalTo;
    message: SignalMessage;
    nowIso: string;
  }): Promise<number> {
    const { data, error } = await this.db
      .from("remote_camera_signals")
      .insert({
        pairing_id: input.pairingId,
        kiosk_id: input.kioskId,
        from_role: input.from,
        to_role: input.to,
        message: input.message,
        created_at: input.nowIso,
      })
      .select("seq")
      .single();
    if (error) fail("push", error);
    return Number((data as Row).seq);
  }

  async poll(input: {
    pairingId: string;
    to: SignalTo;
    afterSeq: number;
    nowIso: string;
    limit?: number;
  }): Promise<MailboxMessage[]> {
    const cutoff = new Date(Date.parse(input.nowIso) - TIMING.signalTtlMs).toISOString();
    const { data, error } = await this.db
      .from("remote_camera_signals")
      .select("seq, from_role, to_role, message, created_at")
      .eq("pairing_id", input.pairingId)
      .eq("to_role", input.to)
      .gt("seq", input.afterSeq)
      .gte("created_at", cutoff)
      .order("seq", { ascending: true })
      .limit(input.limit ?? 50);
    if (error) fail("poll", error);
    return ((data ?? []) as Row[]).map((r) => ({
      seq: Number(r.seq),
      from: r.from_role as SignalFrom,
      to: r.to_role as SignalTo,
      at: iso(r.created_at)!,
      message: r.message as SignalMessage,
    }));
  }

  async purge(nowIso: string): Promise<void> {
    const cutoff = new Date(Date.parse(nowIso) - TIMING.signalTtlMs).toISOString();
    const a = await this.db.from("remote_camera_signals").delete().lt("created_at", cutoff);
    if (a.error) fail("purge signals", a.error);
    const b = await this.db.from("remote_camera_codes").delete().lt("expires_at", nowIso);
    if (b.error) fail("purge codes", b.error);
  }
}
