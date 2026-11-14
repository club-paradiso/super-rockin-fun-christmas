import "server-only";
import { getFrame } from "@/config/frames";
import { mobileBoothFrame, photoSource, type PhotoSource } from "@/config/mobile";
import { getCloudSync, getHubInbox } from "@/lib/cloud/server";
import type { HubInboxStatus } from "@/lib/cloud/inbox";
import { getServerConfig } from "@/lib/server/env";
import { SHARED_OPERATOR, isSharedOperator } from "@/lib/staff-auth/shared";
import { opsStatus, type OpsStatus } from "./backup-server";
import type { CloudSyncStatus } from "@/lib/cloud/sync";
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
  /** Booth camera, or a guest's own phone photo (D66). */
  source: PhotoSource;
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
    frameLabel: mobileLabel(row.frameId) ?? getFrame(row.frameId).label,
    source: photoSource(row),
    status: row.moderationStatus,
    wallConsent: row.wallConsent,
    wallEligible: isWallEligible(row),
    kioskId: row.kioskId,
    kioskLabel: row.kioskId ? (kioskLabels.get(row.kioskId) ?? null) : null,
    sessionShort: row.sessionId.slice(0, 8),
    // A phone photo has no guest link (the guest already has the photo).
    linkActive:
      photoSource(row) === "booth" && !deleted && new Date(row.tokenExpiresAt).getTime() > now,
    tokenExpiresAt: row.tokenExpiresAt,
    deleted,
    actions: availableActions(row),
    canShowQrAgain:
      photoSource(row) === "booth" && !deleted && new Date(row.retentionExpiresAt).getTime() > now,
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
  /** Wall displays: frames per second and JS memory from the last heartbeat. */
  frameRate: number | null;
  memoryMb: number | null;
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
    frameRate: k.frameRate,
    memoryMb: k.memoryMb,
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
  /** Only booth or only phone photos (D66). */
  source?: PhotoSource;
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
  const views = rows.map((r) => toStaffPhotoView(r, labels));
  return q.source ? views.filter((v) => v.source === q.source) : views;
}

/** The moderation queue: consented AND pending, oldest first so nobody waits forever. */
export async function pendingQueue(limit = 60, source?: PhotoSource): Promise<StaffPhotoView[]> {
  const rows = await listStaffPhotos({
    statuses: ["PENDING"],
    wallConsent: true,
    limit: 200,
    source,
  });
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
  /** Hub with a cloud only: QR copies and deletes still waiting for the internet. */
  cloud: CloudSyncStatus | null;
  /** Hub only: USB backup and free disk space. */
  ops: OpsStatus | null;
  /** Hub with a cloud only: phone photos coming down from the cloud inbox (D66). */
  inbox: HubInboxStatus | null;
  /** Review queue split by where the photos came from (D66). */
  pendingBySource: Record<PhotoSource, number>;
  /** What gets deleted when, as configured (shown so staff can tell guests). */
  retention:
    | { where: "cloud"; days: number }
    | { where: "hub"; days: number; unpostedHours: number; wallUntil: string | null };
}

function retentionView(): Overview["retention"] {
  const c = getServerConfig();
  return c.hubRetention
    ? {
        where: "hub",
        days: c.retentionDays,
        unpostedHours: c.hubRetention.unpostedHours,
        wallUntil: c.hubRetention.wallUntil?.toISOString() ?? null,
      }
    : { where: "cloud", days: c.retentionDays };
}

/** Only measured values. Anything we cannot measure is absent, not shown as green. */
export async function getOverview(): Promise<Overview> {
  const backend = getBackend();
  const [stats, kiosks, lastRetention, settings, cloud, ops, pending] = await Promise.all([
    getPhotoService().stats(),
    backend.kiosks.list(),
    backend.retentionRuns.latest(),
    backend.settings.get(),
    getCloudSync()?.status() ?? null,
    opsStatus(),
    getPhotoService().list({ statuses: ["PENDING"], limit: 500 }),
  ]);
  const phone = pending.filter((r) => photoSource(r) === "mobile").length;
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
    cloud,
    ops,
    inbox: getHubInbox()?.status() ?? null,
    pendingBySource: { booth: pending.length - phone, mobile: phone },
    retention: retentionView(),
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
          : isSharedOperator(e.actorId)
            ? SHARED_OPERATOR.displayName
            : e.actorId
              ? (staffNames.get(e.actorId) ?? e.actorId.slice(0, 8))
              : "스태프",
  }));
}

/** "휴대폰 사진", or "휴대폰 사진 · 편지" for one the guest put in a booth frame (D93). */
function mobileLabel(frameId: string): string | null {
  if (photoSource({ frameId }) !== "mobile") return null;
  const frame = mobileBoothFrame(frameId);
  return frame ? `휴대폰 사진 · ${frame.label}` : "휴대폰 사진";
}
