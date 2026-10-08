import type { KioskRow } from "@/lib/storage/types";

/**
 * Kiosk liveness from heartbeats (sent every ~45 s while /kiosk is open).
 *  online  — heartbeat within 2 minutes
 *  stale   — within 15 minutes (tab asleep, brief Wi-Fi drop)
 *  offline — older, or never
 *  revoked — revoked by staff; it can no longer upload or heartbeat
 */
export const HEARTBEAT_INTERVAL_MS = 45_000;
export const ONLINE_WITHIN_MS = 2 * 60_000;
export const STALE_WITHIN_MS = 15 * 60_000;

export type KioskHealth = "online" | "stale" | "offline" | "revoked";

export function kioskHealth(
  k: Pick<KioskRow, "revokedAt" | "heartbeatAt">,
  now = Date.now(),
): KioskHealth {
  if (k.revokedAt) return "revoked";
  if (!k.heartbeatAt) return "offline";
  const age = now - new Date(k.heartbeatAt).getTime();
  if (age <= ONLINE_WITHIN_MS) return "online";
  if (age <= STALE_WITHIN_MS) return "stale";
  return "offline";
}

/** Sanitize a staff-entered kiosk name. */
export function cleanKioskLabel(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const label = input
    .replace(/[^\p{L}\p{N} _.()-]/gu, "")
    .trim()
    .slice(0, 40);
  return label.length ? label : null;
}
