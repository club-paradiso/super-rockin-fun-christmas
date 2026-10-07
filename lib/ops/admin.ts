import "server-only";
import { getFrame } from "@/config/frames";
import { getBackend, getPhotoService } from "@/lib/storage/server";
import type {
  AuditEvent,
  EventSettings,
  KioskRow,
  ModerationStatus,
  PhotoRow,
  RetentionRun,
} from "@/lib/storage/types";
import { kioskHealth, type KioskHealth } from "./kiosks";
import { availableActions, isWallEligible, type ModerationAction } from "./moderation";

/**
 * Staff read models. These are the only shapes staff pages and APIs return: no object paths,
 * no token hashes, no full session ids, no raw tokens.
 */

export interface StaffPhotoView {
  id: string;
  createdAt: string;
  frameId: string;
  frameLabel: string;
  status: ModerationStatus;
  wallConsent: boolean;
  wallEligible: boolean;
  kioskId: string | null;
  kioskLabel: string | null;
  /** First 8 hex chars of the session id, as shown small on the kiosk QR screen. */
  sessionShort: string;
  linkActive: boolean;
  tokenExpiresAt: string;
  deleted: boolean;
  actions: ModerationAction[];
  canShowQrAgain: boolean;
}

export function toStaffPhotoView(
  row: PhotoRow,
  kioskLabels: Map<string, string>,
  now = Date.now(),
): StaffPhotoView {
  const deleted = row.deletedAt !== null || row.moderationStatus === "DELETED";
  return {
    id: row.id,
    createdAt: row.createdAt,
    frameId: row.frameId,
    frameLabel: getFrame(row.frameId).label,
    status: row.moderationStatus,
    wallConsent: row.wallConsent,
    wallEligible: isWallEligible(row),
    kioskId: row.kioskId,
    kioskLabel: row.kioskId ? (kioskLabels.get(row.kioskId) ?? null) : null,
    sessionShort: row.sessionId.slice(0, 8),
    linkActive: !deleted && new Date(row.tokenExpiresAt).getTime() > now,
    tokenExpiresAt: row.tokenExpiresAt,
    deleted,
    actions: availableActions(row),
    canShowQrAgain: !deleted && new Date(row.retentionExpiresAt).getTime() > now,
  };
}

export interface StaffKioskView {
  id: string;
  label: string;
  health: KioskHealth;
  heartbeatAt: string | null;
  lastSeenAt: string | null;
  queueDepth: number | null;
  cameraState: KioskRow["cameraState"];
  appBuild: string | null;
  createdAt: string;
  revokedAt: string | null;
  enrolledVia: KioskRow["enrolledVia"];
}

export function toStaffKioskView(k: KioskRow, now = Date.now()): StaffKioskView {
  return {
    id: k.id,
    label: k.label,
    health: kioskHealth(k, now),
    heartbeatAt: k.heartbeatAt,
    lastSeenAt: k.lastSeenAt,
    queueDepth: k.queueDepth,
    cameraState: k.cameraState,
    appBuild: k.appBuild,
    createdAt: k.createdAt,
    revokedAt: k.revokedAt,
    enrolledVia: k.enrolledVia,
  };
}

export async function kioskLabelMap(): Promise<Map<string, string>> {
  return new Map((await getBackend().kiosks.list()).map((k) => [k.id, k.label]));
}

export const PHOTO_WINDOWS = { "1h": 1, "6h": 6, "12h": 12, "24h": 24, "72h": 72 } as const;
export type PhotoWindow = keyof typeof PHOTO_WINDOWS;

export interface PhotoQuery {
  statuses?: ModerationStatus[];
  wallConsent?: boolean;
  window?: PhotoWindow;
  kioskId?: string;
  sessionShort?: string;
  limit?: number;
}

/** Bounded list: newest first, at most 200 rows, one query + one kiosk lookup (no N+1). */
export async function listStaffPhotos(q: PhotoQuery): Promise<StaffPhotoView[]> {
  const hours = q.window ? PHOTO_WINDOWS[q.window] : undefined;
  const [rows, labels] = await Promise.all([
    getPhotoService().list({
      statuses: q.statuses,
      wallConsent: q.wallConsent,
      since: hours ? new Date(Date.now() - hours * 3_600_000).toISOString() : undefined,
      kioskId: q.kioskId,
      sessionShort:
        q.sessionShort && /^[0-9a-f]{4,8}$/i.test(q.sessionShort) ? q.sessionShort : undefined,
      limit: Math.min(Math.max(q.limit ?? 60, 1), 200),
    }),
    kioskLabelMap(),
  ]);
  return rows.map((r) => toStaffPhotoView(r, labels));
}

/** The moderation queue: consented AND pending, oldest first so nobody waits forever. */
export async function pendingQueue(limit = 60): Promise<StaffPhotoView[]> {
  const rows = await listStaffPhotos({ statuses: ["PENDING"], wallConsent: true, limit: 200 });
  return rows.reverse().slice(0, limit);
}

export interface Overview {
  pendingCount: number;
  byStatus: Record<ModerationStatus, number>;
  storedCount: number;
  storedBytes: number;
  kiosks: {
    online: number;
    stale: number;
    offline: number;
    revoked: number;
    queueDepth: number;
    list: StaffKioskView[];
  };
  lastRetention: RetentionRun | null;
  settings: EventSettings;
}

/** Only measured values. Anything we cannot measure is absent, not shown as green. */
export async function getOverview(): Promise<Overview> {
  const backend = getBackend();
  const [stats, kiosks, lastRetention, settings] = await Promise.all([
    getPhotoService().stats(),
    backend.kiosks.list(),
    backend.retentionRuns.latest(),
    backend.settings.get(),
  ]);
  const views = kiosks.map((k) => toStaffKioskView(k));
  const count = (h: KioskHealth) => views.filter((v) => v.health === h).length;
  return {
    pendingCount: stats.byStatus.PENDING,
    byStatus: stats.byStatus,
    storedCount: stats.storedCount,
    storedBytes: stats.storedBytes,
    kiosks: {
      online: count("online"),
      stale: count("stale"),
      offline: count("offline"),
      revoked: count("revoked"),
      queueDepth: views
        .filter((v) => v.health === "online" || v.health === "stale")
        .reduce((n, v) => n + (v.queueDepth ?? 0), 0),
      list: views,
    },
    lastRetention,
    settings,
  };
}

export interface AuditView extends AuditEvent {
  actorLabel: string;
}

/** Resolve actor ids to current names for display only; the log itself stores ids. */
export async function listAudit(filter: {
  subjectType?: AuditEvent["subjectType"];
  subjectId?: string;
  limit: number;
}): Promise<AuditView[]> {
  const backend = getBackend();
  const [events, staff, kiosks] = await Promise.all([
    backend.audit.list(filter),
    backend.staff.list(),
    backend.kiosks.list(),
  ]);
  const staffNames = new Map(staff.map((s) => [s.userId, s.displayName]));
  const kioskNames = new Map(kiosks.map((k) => [k.id, k.label]));
  return events.map((e) => ({
    ...e,
    actorLabel:
      e.actorType === "system"
        ? "시스템"
        : e.actorType === "kiosk"
          ? `키오스크 ${e.actorId ? (kioskNames.get(e.actorId) ?? e.actorId.slice(0, 8)) : ""}`.trim()
          : e.actorId
            ? (staffNames.get(e.actorId) ?? e.actorId.slice(0, 8))
            : "스태프",
  }));
}
