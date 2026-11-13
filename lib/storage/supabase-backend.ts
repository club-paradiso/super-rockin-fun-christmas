import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  AuditEvent,
  AuditRepository,
  AuditSubject,
  EnrollmentCodeRepository,
  EnrollmentCodeRow,
  EventSettings,
  KioskHeartbeat,
  KioskRepository,
  KioskRow,
  ModerationStatus,
  ObjectMime,
  ObjectStorage,
  PhotoListFilter,
  PhotoMime,
  PhotoPatch,
  PhotoRepository,
  PhotoRow,
  PhotoStats,
  PhotoTransition,
  RetentionRun,
  RetentionRunRepository,
  SettingsPatch,
  SettingsRepository,
  StaffMember,
  StaffRepository,
  StorageBackend,
  WallEligibleRow,
  WallRepository,
} from "./types";
import { MODERATION_STATES } from "./types";
import { DEFAULT_WALL_THEME, WALL_THEMES } from "@/config/wall-themes";
import { normalizeLook } from "@/lib/wall/themes";
import type { VideoMime } from "@/lib/video/format";

/**
 * Supabase Postgres + private Storage bucket, accessed only from the Next.js server with the
 * service-role key. The browser never talks to Supabase. Schema: supabase/migrations.
 * Audited mutations call SQL functions (ftl_*) so change + audit commit in one transaction.
 */

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

const toPhoto = (r: Row): PhotoRow => ({
  id: r.id as string,
  sessionId: r.session_id as string,
  kioskId: (r.kiosk_id as string | null) ?? null,
  frameId: r.frame_id as string,
  mime: r.mime as PhotoMime,
  bytes: r.bytes as number,
  objectPath: r.object_path as string,
  thumbPath: (r.thumb_path as string | null) ?? null,
  tokenHash: r.token_hash as string,
  tokenExpiresAt: iso(r.token_expires_at)!,
  retentionExpiresAt: iso(r.retention_expires_at)!,
  wallConsent: r.wall_consent as boolean,
  wallPublic: (r.wall_public as boolean | null) ?? false,
  moderationStatus: r.moderation_status as ModerationStatus,
  deletedAt: iso(r.deleted_at),
  objectDeletedAt: iso(r.object_deleted_at),
  videoMime: (r.video_mime as VideoMime | null) ?? null,
  videoBytes: (r.video_bytes as number | null) ?? null,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

const toWallEligible = (r: Row): WallEligibleRow => ({
  id: r.id as string,
  createdAt: iso(r.created_at)!,
  frameId: r.frame_id as string,
  mime: r.mime as PhotoMime,
  thumbPath: (r.thumb_path as string | null) ?? null,
  objectPath: r.object_path as string,
});

const toKiosk = (r: Row): KioskRow => ({
  id: r.id as string,
  label: r.label as string,
  createdAt: iso(r.created_at)!,
  revokedAt: iso(r.revoked_at),
  lastSeenAt: iso(r.last_seen_at),
  heartbeatAt: iso(r.heartbeat_at),
  queueDepth: (r.queue_depth as number | null) ?? null,
  cameraState: (r.camera_state as KioskRow["cameraState"]) ?? null,
  appBuild: (r.app_build as string | null) ?? null,
  enrolledVia: (r.enrolled_via as KioskRow["enrolledVia"]) ?? "secret",
  frameRate: r.frame_rate == null ? null : Number(r.frame_rate),
  memoryMb: (r.memory_mb as number | null) ?? null,
});

const toCode = (r: Row): EnrollmentCodeRow => ({
  id: r.id as string,
  codeHash: r.code_hash as string,
  label: r.label as string,
  createdBy: r.created_by as string,
  createdAt: iso(r.created_at)!,
  expiresAt: iso(r.expires_at)!,
  usedAt: iso(r.used_at),
  usedKioskId: (r.used_kiosk_id as string | null) ?? null,
});

const toSettings = (r: Row): EventSettings => ({
  pauseSubmissions: r.pause_submissions as boolean,
  pauseWall: r.pause_wall as boolean,
  showHoldingScreen: r.show_holding_screen as boolean,
  wallHours:
    r.wall_hours_start && r.wall_hours_end
      ? { start: r.wall_hours_start as string, end: r.wall_hours_end as string }
      : null,
  wallForce: (r.wall_force as EventSettings["wallForce"]) ?? "auto",
  kioskDefaultMode: (r.kiosk_default_mode as EventSettings["kioskDefaultMode"]) ?? "standard",
  wallPublic: (r.wall_public as boolean | null) ?? false,
  wallLook: normalizeLook(r.wall_look, WALL_THEMES, DEFAULT_WALL_THEME),
  updatedAt: iso(r.updated_at)!,
  updatedBy: (r.updated_by as string | null) ?? null,
});

const toStaff = (r: Row): StaffMember => ({
  userId: r.user_id as string,
  email: r.email as string,
  displayName: r.display_name as string,
  role: "staff",
  active: r.active as boolean,
  createdAt: iso(r.created_at)!,
});

const toAudit = (r: Row): AuditEvent => ({
  id: Number(r.id),
  occurredAt: iso(r.occurred_at)!,
  actorType: r.actor_type as AuditEvent["actorType"],
  actorId: (r.actor_id as string | null) ?? null,
  action: r.action as string,
  subjectType: r.subject_type as AuditSubject,
  subjectId: r.subject_id as string,
  fromState: (r.from_state as string | null) ?? null,
  toState: (r.to_state as string | null) ?? null,
  note: (r.note as string | null) ?? null,
  details: (r.details as Record<string, unknown>) ?? {},
});

export class SupabaseError extends Error {
  constructor(
    op: string,
    readonly cause: { message?: string; code?: string } | null,
  ) {
    super(
      `supabase ${op} failed${cause?.code ? ` (${cause.code})` : ""}: ${cause?.message ?? "unknown"}`,
    );
  }
}

async function rpcRows(db: SupabaseClient, fn: string, args: Row): Promise<Row[]> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new SupabaseError(fn, error);
  return (data as Row[] | null) ?? [];
}

class SupabasePhotoRepository implements PhotoRepository {
  constructor(private readonly db: SupabaseClient) {}

  private async one(column: string, value: string) {
    const { data, error } = await this.db
      .from("photos")
      .select("*")
      .eq(column, value)
      .maybeSingle();
    if (error) throw new SupabaseError(`select photo by ${column}`, error);
    return data ? toPhoto(data) : null;
  }

  getById(id: string) {
    return this.one("id", id);
  }
  findBySessionId(sessionId: string) {
    return this.one("session_id", sessionId);
  }
  findByTokenHash(tokenHash: string) {
    return this.one("token_hash", tokenHash);
  }

  async insert(row: PhotoRow) {
    const { error } = await this.db.from("photos").insert({
      id: row.id,
      session_id: row.sessionId,
      kiosk_id: row.kioskId,
      frame_id: row.frameId,
      mime: row.mime,
      bytes: row.bytes,
      object_path: row.objectPath,
      thumb_path: row.thumbPath,
      token_hash: row.tokenHash,
      token_expires_at: row.tokenExpiresAt,
      retention_expires_at: row.retentionExpiresAt,
      wall_consent: row.wallConsent,
      wall_public: row.wallConsent && row.wallPublic,
      moderation_status: row.moderationStatus,
      created_at: row.createdAt,
    });
    if (!error) return "inserted" as const;
    if (error.code === "23505" && /session_id/.test(error.message + (error.details ?? ""))) {
      return "conflict" as const;
    }
    throw new SupabaseError("insert photo", error);
  }

  async update(id: string, patch: PhotoPatch) {
    const db: Row = {};
    if (patch.tokenHash !== undefined) db.token_hash = patch.tokenHash;
    if (patch.tokenExpiresAt !== undefined) db.token_expires_at = patch.tokenExpiresAt;
    const { data, error } = await this.db
      .from("photos")
      .update(db)
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) throw new SupabaseError("update photo", error);
    return data ? toPhoto(data) : null;
  }

  async transition(t: PhotoTransition) {
    const rows = await rpcRows(this.db, "ftl_photo_transition", {
      p_photo_id: t.photoId,
      p_from: t.from,
      p_to: t.to,
      p_wall_consent: t.wallConsent ?? null,
      p_wall_public: t.wallPublic ?? null,
      p_deleted_at: t.deletedAt ?? null,
      p_actor_type: t.actor.type,
      p_actor_id: t.actor.id,
      p_action: t.action,
      p_note: t.note ?? null,
    });
    return rows[0] ? toPhoto(rows[0]) : null;
  }

  async rotateToken(id: string, tokenHash: string, tokenExpiresAt: string, staffUserId: string) {
    const rows = await rpcRows(this.db, "ftl_photo_rotate_token", {
      p_photo_id: id,
      p_token_hash: tokenHash,
      p_token_expires_at: tokenExpiresAt,
      p_actor_id: staffUserId,
    });
    return rows[0] ? toPhoto(rows[0]) : null;
  }

  async setThumbPath(id: string, path: string) {
    const { error } = await this.db.from("photos").update({ thumb_path: path }).eq("id", id);
    if (error) throw new SupabaseError("set thumb", error);
  }

  async setVideo(id: string, video: { mime: VideoMime; bytes: number }) {
    const { error } = await this.db
      .from("photos")
      .update({ video_mime: video.mime, video_bytes: video.bytes })
      .eq("id", id);
    if (error) throw new SupabaseError("set video", error);
  }

  async markObjectsDeleted(id: string, atIso: string) {
    const { error } = await this.db
      .from("photos")
      .update({ object_deleted_at: atIso })
      .eq("id", id);
    if (error) throw new SupabaseError("mark objects deleted", error);
  }

  async listRetentionDue(nowIso: string, limit: number) {
    const { data, error } = await this.db
      .from("photos")
      .select("*")
      .is("deleted_at", null)
      .lte("retention_expires_at", nowIso)
      .order("retention_expires_at", { ascending: true })
      .limit(limit);
    if (error) throw new SupabaseError("list retention", error);
    return (data as Row[]).map(toPhoto);
  }

  async listObjectCleanupDue(limit: number) {
    const { data, error } = await this.db
      .from("photos")
      .select("*")
      .not("deleted_at", "is", null)
      .is("object_deleted_at", null)
      .limit(limit);
    if (error) throw new SupabaseError("list object cleanup", error);
    return (data as Row[]).map(toPhoto);
  }

  async list(f: PhotoListFilter) {
    let q = this.db.from("photos").select("*");
    if (f.statuses) q = q.in("moderation_status", f.statuses);
    if (f.wallConsent !== undefined) q = q.eq("wall_consent", f.wallConsent);
    if (f.since) q = q.gte("created_at", f.since);
    if (f.before) q = q.lt("created_at", f.before);
    if (f.kioskId) q = q.eq("kiosk_id", f.kioskId);
    if (f.kioskless) q = q.is("kiosk_id", null);
    if (f.frameId) q = q.eq("frame_id", f.frameId);
    if (f.sessionShort) q = q.like("session_short", `${f.sessionShort.toLowerCase()}%`);
    const { data, error } = await q
      .order("created_at", { ascending: !!f.oldestFirst })
      .limit(f.limit);
    if (error) throw new SupabaseError("list photos", error);
    return (data as Row[]).map(toPhoto);
  }

  // The cloud never keeps a cloud copy of itself: these exist on the hub only (FTL_ROLE=hub).
  async setCloud(): Promise<never> {
    throw new Error("cloud-copy bookkeeping lives on the hub (local backend)");
  }
  async listCloudDue() {
    return [];
  }

  /**
   * Reads the `wall_eligible_photos` view (or `wall_public_photos` for the public audience, D86),
   * so both wall rules also live in the database.
   */
  async listWallEligible(limit: number, publicOnly = false) {
    const { data, error } = await this.db
      .from(publicOnly ? "wall_public_photos" : "wall_eligible_photos")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new SupabaseError("list wall photos", error);
    return (data as Row[]).map(toWallEligible);
  }

  async stats(): Promise<PhotoStats> {
    const { data, error } = await this.db.rpc("ftl_photo_stats");
    if (error) throw new SupabaseError("photo stats", error);
    const raw = data as {
      by_status: Record<string, number>;
      stored_count: number;
      stored_bytes: number;
    };
    const byStatus = Object.fromEntries(
      MODERATION_STATES.map((s) => [s, Number(raw.by_status[s] ?? 0)]),
    ) as PhotoStats["byStatus"];
    return {
      byStatus,
      storedCount: Number(raw.stored_count),
      storedBytes: Number(raw.stored_bytes),
    };
  }
}

class SupabaseObjectStorage implements ObjectStorage {
  constructor(
    private readonly db: SupabaseClient,
    private readonly bucket: string,
  ) {}

  async put(path: string, data: Uint8Array, mime: ObjectMime) {
    const { error } = await this.db.storage
      .from(this.bucket)
      .upload(path, data, { contentType: mime, upsert: false, cacheControl: "0" });
    if (error) throw new SupabaseError("storage upload", error);
  }

  async get(path: string) {
    const { data, error } = await this.db.storage.from(this.bucket).download(path);
    if (error) {
      const status = (error as { status?: number }).status;
      if (status === 400 || status === 404 || /not.?found/i.test(error.message)) return null;
      throw new SupabaseError("storage download", error);
    }
    return new Uint8Array(await data.arrayBuffer());
  }

  async remove(path: string) {
    // Supabase reports success (empty list) for objects that do not exist: idempotent.
    const { error } = await this.db.storage.from(this.bucket).remove([path]);
    if (error) throw new SupabaseError("storage remove", error);
  }
}

class SupabaseKioskRepository implements KioskRepository {
  constructor(private readonly db: SupabaseClient) {}

  async insert(row: KioskRow) {
    const { error } = await this.db.from("kiosks").insert({
      id: row.id,
      label: row.label,
      created_at: row.createdAt,
      enrolled_via: row.enrolledVia,
    });
    if (error) throw new SupabaseError("insert kiosk", error);
  }
  async get(id: string) {
    const { data, error } = await this.db.from("kiosks").select("*").eq("id", id).maybeSingle();
    if (error) throw new SupabaseError("get kiosk", error);
    return data ? toKiosk(data) : null;
  }
  async revoke(id: string, atIso: string) {
    const { data, error } = await this.db
      .from("kiosks")
      .update({ revoked_at: atIso })
      .eq("id", id)
      .is("revoked_at", null)
      .select("id");
    if (error) throw new SupabaseError("revoke kiosk", error);
    if (data.length) return true;
    return (await this.get(id)) !== null;
  }
  async touch(id: string, atIso: string) {
    const { error } = await this.db.from("kiosks").update({ last_seen_at: atIso }).eq("id", id);
    if (error) throw new SupabaseError("touch kiosk", error);
  }
  async heartbeat(id: string, hb: KioskHeartbeat) {
    const { error } = await this.db
      .from("kiosks")
      .update({
        heartbeat_at: hb.atIso,
        last_seen_at: hb.atIso,
        queue_depth: hb.queueDepth,
        camera_state: hb.cameraState,
        app_build: hb.appBuild,
        frame_rate: hb.frameRate ?? null,
        memory_mb: hb.memoryMb ?? null,
      })
      .eq("id", id);
    if (error) throw new SupabaseError("kiosk heartbeat", error);
  }
  async update(
    id: string,
    change: { label?: string | null; revoke?: boolean },
    staffUserId: string,
  ) {
    const rows = await rpcRows(this.db, "ftl_kiosk_update", {
      p_kiosk_id: id,
      p_label: change.label ?? null,
      p_revoke: !!change.revoke,
      p_actor_id: staffUserId,
    });
    return rows[0] ? toKiosk(rows[0]) : null;
  }
  async list() {
    const { data, error } = await this.db.from("kiosks").select("*").order("created_at");
    if (error) throw new SupabaseError("list kiosks", error);
    return (data as Row[]).map(toKiosk);
  }
}

class SupabaseEnrollmentCodeRepository implements EnrollmentCodeRepository {
  constructor(private readonly db: SupabaseClient) {}

  async create(row: Omit<EnrollmentCodeRow, "usedAt" | "usedKioskId">) {
    const rows = await rpcRows(this.db, "ftl_enrollment_code_create", {
      p_id: row.id,
      p_code_hash: row.codeHash,
      p_label: row.label,
      p_expires_at: row.expiresAt,
      p_actor_id: row.createdBy,
    });
    return toCode(rows[0]!);
  }
  async consume(codeHash: string, kioskId: string) {
    // Expiry is checked against the database clock (now()) inside the function.
    const rows = await rpcRows(this.db, "ftl_enrollment_code_consume", {
      p_code_hash: codeHash,
      p_kiosk_id: kioskId,
    });
    return rows[0] ? toKiosk(rows[0]) : null;
  }
  async listRecent(limit: number) {
    const { data, error } = await this.db
      .from("kiosk_enrollment_codes")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new SupabaseError("list enrollment codes", error);
    return (data as Row[]).map(toCode);
  }
}

class SupabaseSettingsRepository implements SettingsRepository {
  constructor(private readonly db: SupabaseClient) {}

  async get() {
    const { data, error } = await this.db.from("event_settings").select("*").eq("id", 1).single();
    if (error) throw new SupabaseError("get settings", error);
    return toSettings(data);
  }
  async update(patch: SettingsPatch, staffUserId: string) {
    const rows = await rpcRows(this.db, "ftl_settings_update", {
      p_pause_submissions: patch.pauseSubmissions ?? null,
      p_pause_wall: patch.pauseWall ?? null,
      p_show_holding_screen: patch.showHoldingScreen ?? null,
      p_wall_force: patch.wallForce ?? null,
      // Hours are nullable themselves, so "leave unchanged" needs its own flag.
      p_set_wall_hours: patch.wallHours !== undefined,
      p_wall_hours_start: patch.wallHours?.start ?? null,
      p_wall_hours_end: patch.wallHours?.end ?? null,
      p_kiosk_default_mode: patch.kioskDefaultMode ?? null,
      p_wall_public: patch.wallPublic ?? null,
      p_wall_look: patch.wallLook ?? null,
      p_actor_id: staffUserId,
    });
    return toSettings(rows[0]!);
  }
}

class SupabaseStaffRepository implements StaffRepository {
  constructor(private readonly db: SupabaseClient) {}

  async get(userId: string) {
    const { data, error } = await this.db
      .from("staff_members")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new SupabaseError("get staff", error);
    return data ? toStaff(data) : null;
  }
  async list() {
    const { data, error } = await this.db.from("staff_members").select("*").order("email");
    if (error) throw new SupabaseError("list staff", error);
    return (data as Row[]).map(toStaff);
  }
  async upsert(
    m: { userId: string; email: string; displayName?: string | null; active?: boolean | null },
    actorId: string | null,
  ) {
    const rows = await rpcRows(this.db, "ftl_staff_upsert", {
      p_user_id: m.userId,
      p_email: m.email,
      p_display_name: m.displayName ?? null,
      p_active: m.active ?? null,
      p_actor_id: actorId,
    });
    return toStaff(rows[0]!);
  }
  // PIN login exists only on the hub, which always uses the local backend (FTL_ROLE=hub).
  async setPin(): Promise<never> {
    throw new Error("staff PINs live on the hub (local backend), not in Supabase");
  }
  async getPin() {
    return null;
  }
}

class SupabaseAuditRepository implements AuditRepository {
  constructor(private readonly db: SupabaseClient) {}

  async list(f: { subjectType?: AuditSubject; subjectId?: string; limit: number }) {
    let q = this.db.from("audit_events").select("*");
    if (f.subjectType) q = q.eq("subject_type", f.subjectType);
    if (f.subjectId) q = q.eq("subject_id", f.subjectId);
    const { data, error } = await q.order("id", { ascending: false }).limit(f.limit);
    if (error) throw new SupabaseError("list audit", error);
    return (data as Row[]).map(toAudit);
  }
}

/**
 * The wall runs on the hub (D40), which keeps rotation state in its local files. The cloud does
 * not persist it: `exposures()` returns null and the wall feed falls back to newest-first (D52).
 */
class SupabaseWallRepository implements WallRepository {
  async exposures() {
    return null;
  }
  async report() {}
  async requestShowNow(): Promise<never> {
    throw new Error("show-now lives on the hub (FTL_ROLE=hub)");
  }
  async showNowQueue() {
    return [];
  }
}

class SupabaseRetentionRunRepository implements RetentionRunRepository {
  constructor(private readonly db: SupabaseClient) {}

  async record(run: RetentionRun) {
    const { error } = await this.db.from("retention_runs").insert({
      ran_at: run.ranAt,
      examined: run.examined,
      deleted: run.deleted,
      failed: run.failed,
    });
    if (error) throw new SupabaseError("record retention run", error);
  }
  async latest() {
    const { data, error } = await this.db
      .from("retention_runs")
      .select("*")
      .order("ran_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new SupabaseError("latest retention run", error);
    return data
      ? {
          ranAt: iso(data.ran_at)!,
          examined: data.examined,
          deleted: data.deleted,
          failed: data.failed,
        }
      : null;
  }
}

export function createServiceClient(opts: { url: string; serviceRoleKey: string }): SupabaseClient {
  return createClient(opts.url, opts.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-client-info": "follow-the-lights-server" } },
  });
}

export function createSupabaseBackend(opts: {
  url: string;
  serviceRoleKey: string;
  bucket: string;
}): StorageBackend {
  const db = createServiceClient(opts);
  return {
    name: "supabase",
    photos: new SupabasePhotoRepository(db),
    objects: new SupabaseObjectStorage(db, opts.bucket),
    kiosks: new SupabaseKioskRepository(db),
    enrollmentCodes: new SupabaseEnrollmentCodeRepository(db),
    settings: new SupabaseSettingsRepository(db),
    staff: new SupabaseStaffRepository(db),
    audit: new SupabaseAuditRepository(db),
    retentionRuns: new SupabaseRetentionRunRepository(db),
    wall: new SupabaseWallRepository(),
  };
}
