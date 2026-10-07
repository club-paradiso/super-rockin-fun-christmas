import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  KioskRepository,
  KioskRow,
  ObjectStorage,
  PhotoMime,
  PhotoPatch,
  PhotoRepository,
  PhotoRow,
  StorageBackend,
} from "./types";

/**
 * Supabase Postgres + private Storage bucket, accessed only from the Next.js server with the
 * service-role key. The browser never talks to Supabase. Schema: supabase/migrations.
 */

interface PhotoDbRow {
  id: string;
  session_id: string;
  kiosk_id: string | null;
  frame_id: string;
  mime: PhotoMime;
  bytes: number;
  object_path: string;
  token_hash: string;
  token_expires_at: string;
  retention_expires_at: string;
  wall_consent: boolean;
  moderation_status: PhotoRow["moderationStatus"];
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface KioskDbRow {
  id: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
  last_seen_at: string | null;
}

const toPhoto = (r: PhotoDbRow): PhotoRow => ({
  id: r.id,
  sessionId: r.session_id,
  kioskId: r.kiosk_id,
  frameId: r.frame_id,
  mime: r.mime,
  bytes: r.bytes,
  objectPath: r.object_path,
  tokenHash: r.token_hash,
  tokenExpiresAt: new Date(r.token_expires_at).toISOString(),
  retentionExpiresAt: new Date(r.retention_expires_at).toISOString(),
  wallConsent: r.wall_consent,
  moderationStatus: r.moderation_status,
  deletedAt: r.deleted_at && new Date(r.deleted_at).toISOString(),
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

const toKiosk = (r: KioskDbRow): KioskRow => ({
  id: r.id,
  label: r.label,
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
  lastSeenAt: r.last_seen_at,
});

const patchToDb = (p: PhotoPatch) => {
  const out: Partial<PhotoDbRow> = {};
  if (p.tokenHash !== undefined) out.token_hash = p.tokenHash;
  if (p.tokenExpiresAt !== undefined) out.token_expires_at = p.tokenExpiresAt;
  if (p.wallConsent !== undefined) out.wall_consent = p.wallConsent;
  if (p.moderationStatus !== undefined) out.moderation_status = p.moderationStatus;
  if (p.deletedAt !== undefined) out.deleted_at = p.deletedAt;
  return out;
};

class SupabaseError extends Error {
  constructor(op: string, err: { message?: string; code?: string } | null) {
    super(
      `supabase ${op} failed${err?.code ? ` (${err.code})` : ""}: ${err?.message ?? "unknown"}`,
    );
  }
}

const PHOTO_COLUMNS =
  "id,session_id,kiosk_id,frame_id,mime,bytes,object_path,token_hash,token_expires_at,retention_expires_at,wall_consent,moderation_status,deleted_at,created_at,updated_at";

class SupabasePhotoRepository implements PhotoRepository {
  constructor(private readonly db: SupabaseClient) {}

  private async one(column: "session_id" | "token_hash", value: string) {
    const { data, error } = await this.db
      .from("photos")
      .select(PHOTO_COLUMNS)
      .eq(column, value)
      .maybeSingle();
    if (error) throw new SupabaseError(`select by ${column}`, error);
    return data ? toPhoto(data as PhotoDbRow) : null;
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
      token_hash: row.tokenHash,
      token_expires_at: row.tokenExpiresAt,
      retention_expires_at: row.retentionExpiresAt,
      wall_consent: row.wallConsent,
      moderation_status: row.moderationStatus,
      created_at: row.createdAt,
    });
    if (!error) return "inserted" as const;
    if (error.code === "23505" && /session_id/.test(error.message + (error.details ?? "")))
      return "conflict" as const;
    throw new SupabaseError("insert photo", error);
  }

  async update(id: string, patch: PhotoPatch) {
    const { data, error } = await this.db
      .from("photos")
      .update(patchToDb(patch))
      .eq("id", id)
      .select(PHOTO_COLUMNS)
      .maybeSingle();
    if (error) throw new SupabaseError("update photo", error);
    return data ? toPhoto(data as PhotoDbRow) : null;
  }

  async listRetentionDue(nowIso: string, limit: number) {
    const { data, error } = await this.db
      .from("photos")
      .select(PHOTO_COLUMNS)
      .is("deleted_at", null)
      .lte("retention_expires_at", nowIso)
      .order("retention_expires_at", { ascending: true })
      .limit(limit);
    if (error) throw new SupabaseError("list retention", error);
    return (data as PhotoDbRow[]).map(toPhoto);
  }
}

class SupabaseObjectStorage implements ObjectStorage {
  constructor(
    private readonly db: SupabaseClient,
    private readonly bucket: string,
  ) {}

  async put(path: string, data: Uint8Array, mime: PhotoMime) {
    const { error } = await this.db.storage
      .from(this.bucket)
      .upload(path, data, { contentType: mime, upsert: false, cacheControl: "0" });
    if (error) throw new SupabaseError("storage upload", error);
  }

  async get(path: string) {
    const { data, error } = await this.db.storage.from(this.bucket).download(path);
    if (error) {
      const status = (error as { status?: number; statusCode?: string }).status;
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
    const { error } = await this.db
      .from("kiosks")
      .insert({ id: row.id, label: row.label, created_at: row.createdAt });
    if (error) throw new SupabaseError("insert kiosk", error);
  }
  async get(id: string) {
    const { data, error } = await this.db.from("kiosks").select("*").eq("id", id).maybeSingle();
    if (error) throw new SupabaseError("get kiosk", error);
    return data ? toKiosk(data as KioskDbRow) : null;
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
  async list() {
    const { data, error } = await this.db.from("kiosks").select("*").order("created_at");
    if (error) throw new SupabaseError("list kiosks", error);
    return (data as KioskDbRow[]).map(toKiosk);
  }
}

export function createSupabaseBackend(opts: {
  url: string;
  serviceRoleKey: string;
  bucket: string;
}): StorageBackend {
  const db = createClient(opts.url, opts.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-client-info": "follow-the-lights-server" } },
  });
  return {
    name: "supabase",
    photos: new SupabasePhotoRepository(db),
    objects: new SupabaseObjectStorage(db, opts.bucket),
    kiosks: new SupabaseKioskRepository(db),
  };
}
