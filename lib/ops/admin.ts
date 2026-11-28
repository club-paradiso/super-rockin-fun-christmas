import "server-only";
import { getFrame } from "@/config/frames";
import { mobileBoothFrame, photoSource, type PhotoSource } from "@/config/mobile";
import { CATEGORY_LABEL_KO, REASON_LABEL_KO, type ModerationCategory } from "@/config/moderation";
import { getCloudSync, getHubInbox } from "@/lib/cloud/server";
import { getAiReview } from "@/lib/moderation/server";
import type { AiStatus } from "@/lib/moderation/service";
import type { HubInboxStatus } from "@/lib/cloud/inbox";
import { getServerConfig } from "@/lib/server/env";
import { logEvent } from "@/lib/server/log";
import { SHARED_OPERATOR, isSharedOperator } from "@/lib/staff-auth/shared";
import { opsStatus, type OpsStatus } from "./backup-server";
import type { CloudSyncStatus } from "@/lib/cloud/sync";
import { getBackend, getPhotoService } from "@/lib/storage/server";
import type {
  AiReviewStatus,
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
  /** AI review (D95), in staff words. Null = the AI was never asked about this photo. */
  ai: StaffAiView | null;
}

/**
 * What staff see of an AI review. `notes` are our own fixed Korean sentences for the codes the
 * review stored; nothing a provider wrote is ever shown, and there is no score.
 */
export interface StaffAiView {
  status: Exclude<AiReviewStatus, "NONE">;
  /** This photo reached the wall on the AI's word (no person approved it). */
  approvedByAi: boolean;
  notes: string[];
  reviewedAt: string | null;
}

function toStaffAiView(row: PhotoRow): StaffAiView | null {
  const ai = row.ai;
  if (!ai || ai.status === "NONE") return null;
  const notes =
    ai.status === "UNSAFE"
      ? ai.categories.map((c) => CATEGORY_LABEL_KO[c as ModerationCategory] ?? "확인 필요")
      : ai.status === "SAFE" || ai.status === "QUEUED" || !ai.reason
        ? []
        : [REASON_LABEL_KO[ai.reason] ?? "AI가 확인하지 못했어요"];
  return {
    status: ai.status,
    approvedByAi: ai.status === "SAFE" && row.moderationStatus === "APPROVED",
    notes,
    reviewedAt: ai.reviewedAt,
  };
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
    ai: toStaffAiView(row),
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
  /** Booths with 「카메라 자동 보정」 on: the engine's status from the last heartbeat. */
  cameraEngine: KioskRow["cameraEngine"];
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
    cameraEngine: k.cameraEngine,
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
  /** Only these AI review states (D95). */
  aiStatuses?: AiReviewStatus[];
  /** Captured strictly before this instant (the next page of a newest-first list). */
  before?: string;
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
      aiStatuses: q.aiStatuses,
      before: q.before,
      limit: Math.min(Math.max(q.limit ?? 60, 1), 200),
    }),
    kioskLabelMap(),
  ]);
  const views = rows.map((r) => toStaffPhotoView(r, labels));
  return q.source ? views.filter((v) => v.source === q.source) : views;
}

/**
 * The moderation queue: consented AND pending, oldest first so nobody waits forever. Photos the
 * AI flagged come first (D95): they are the ones most likely to need a "no".
 */
export async function pendingQueue(limit = 60, source?: PhotoSource): Promise<StaffPhotoView[]> {
  const rows = await listStaffPhotos({
    statuses: ["PENDING"],
    wallConsent: true,
    limit: 200,
    source,
  });
  const oldestFirst = rows.reverse();
  const flagged = oldestFirst.filter((p) => p.ai?.status === "UNSAFE");
  const rest = oldestFirst.filter((p) => p.ai?.status !== "UNSAFE");
  return [...flagged, ...rest].slice(0, limit);
}

export const MODERATION_VIEWS = [
  "queue",
  "on-wall",
  "flagged",
  "ai-approved",
  "rejected",
  "hidden",
] as const;
export type ModerationView = (typeof MODERATION_VIEWS)[number];

/** The sections of the review page other than the queue (D95). Newest first, bounded. */
export async function moderationSection(
  view: Exclude<ModerationView, "queue">,
  limit = 60,
  before?: string,
): Promise<StaffPhotoView[]> {
  switch (view) {
    // Everything the wall may show right now (the `isWallEligible` rule), whoever approved it,
    // with no time window: staff page back through all of it with `before`.
    case "on-wall":
      return listStaffPhotos({ statuses: ["APPROVED"], wallConsent: true, limit, before });
    case "flagged":
      return listStaffPhotos({
        statuses: ["PENDING"],
        wallConsent: true,
        aiStatuses: ["UNSAFE"],
        limit,
      });
    case "ai-approved":
      return listStaffPhotos({ statuses: ["APPROVED"], aiStatuses: ["SAFE"], limit });
    case "rejected":
      return listStaffPhotos({ statuses: ["REJECTED"], limit });
    case "hidden":
      return listStaffPhotos({ statuses: ["HIDDEN"], limit });
  }
}

/** How many photos the wall may show right now (APPROVED + consent + not deleted). Ids only. */
export async function onWallCount(): Promise<number> {
  return (await getPhotoService().wallPhotos(20_000)).length;
}

export interface AiOverview extends AiStatus {
  /** Why the AI settings on this server were refused, or null. For the technical contact. */
  problem: string | null;
  /** Why the fallback AI settings were refused (D98), or null. Only the fallback is off then. */
  fallbackProblem: string | null;
}

/**
 * Never throws: the overview is where staff find the emergency switches, and it must open even
 * when the AI review tables are not there yet (code deployed before its migration) or the
 * database hiccups. The card then says the AI is unavailable and everything else works.
 */
export async function getAiOverview(): Promise<AiOverview> {
  const config = getServerConfig();
  try {
    return {
      ...(await getAiReview().status()),
      problem: config.aiModerationProblem,
      fallbackProblem: config.aiModerationFallbackProblem,
    };
  } catch (err) {
    logEvent("ai_status_failed", { message: (err as Error).message.slice(0, 200) }, "warn");
    const zero = { NONE: 0, QUEUED: 0, SAFE: 0, UNSAFE: 0, UNCERTAIN: 0, FAILED: 0, SKIPPED: 0 };
    return {
      configured: false,
      provider: null,
      model: null,
      mode: "manual",
      active: false,
      dailyLimit: 0,
      pausedUntil: null,
      usage: {
        day: "",
        requests: 0,
        succeeded: 0,
        failed: 0,
        approved: 0,
        flagged: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureReason: null,
      },
      pending: zero,
      fallback: null,
      primaryOffUntil: null,
      fallbackProblem: config.aiModerationFallbackProblem,
      problem:
        config.aiModerationProblem ??
        "AI review status could not be read (is migration 20261114120000_ai_review.sql applied?)",
    };
  }
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
  /** AI review: mode, provider health, today's usage (D95). */
  ai: AiOverview;
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
  const [stats, kiosks, lastRetention, settings, cloud, ops, pending, ai] = await Promise.all([
    getPhotoService().stats(),
    backend.kiosks.list(),
    backend.retentionRuns.latest(),
    backend.settings.get(),
    getCloudSync()?.status() ?? null,
    opsStatus(),
    getPhotoService().list({ statuses: ["PENDING"], limit: 500 }),
    getAiOverview(),
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
    ai,
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
