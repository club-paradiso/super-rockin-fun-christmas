import type pg from "pg";
import { fromDb } from "@/lib/storage/supabase-backend";
import type {
  AiCompletion,
  AiReviewRepository,
  AiReviewStatusView,
  AuditRepository,
  PhotoRepository,
  PhotoRow,
  PhotoTransition,
  SettingsPatch,
  SettingsRepository,
  StorageBackend,
} from "@/lib/storage/types";
import { AI_REVIEW_STATES } from "@/lib/storage/types";

type Row = Record<string, unknown>;

/**
 * The part of a storage backend the AI review queue needs, straight on Postgres: the same SQL
 * functions and the same row mappers as the Supabase adapter, without PostgREST in between. It
 * lets the migration's functions, trigger and grants be tested on any Postgres (this repository's
 * CI has no Docker for the full Supabase stack). Tests only.
 */
export function createPgAiBackend(
  db: pg.Pool,
): Pick<StorageBackend, "photos" | "aiReviews" | "settings" | "audit"> {
  const one = async (sql: string, args: unknown[]) => (await db.query(sql, args)).rows as Row[];

  const photos = {
    async getById(id: string) {
      const [r] = await one("select * from public.photos where id = $1", [id]);
      return r ? fromDb.photo(r) : null;
    },
    async insert(row: PhotoRow) {
      await db.query(
        `insert into public.photos (id, session_id, kiosk_id, frame_id, mime, bytes, object_path,
           thumb_path, token_hash, token_expires_at, retention_expires_at, wall_consent,
           wall_public, moderation_status, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          row.id,
          row.sessionId,
          row.kioskId,
          row.frameId,
          row.mime,
          row.bytes,
          row.objectPath,
          row.thumbPath,
          row.tokenHash,
          row.tokenExpiresAt,
          row.retentionExpiresAt,
          row.wallConsent,
          row.wallConsent && row.wallPublic,
          row.moderationStatus,
          row.createdAt,
        ],
      );
      return "inserted" as const;
    },
    async transition(t: PhotoTransition) {
      const [r] = await one(
        "select * from public.ftl_photo_transition($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          t.photoId,
          t.from,
          t.to,
          t.wallConsent ?? null,
          t.wallPublic ?? null,
          t.deletedAt ?? null,
          t.actor.type,
          t.actor.id,
          t.action,
          t.note ?? null,
        ],
      );
      return r ? fromDb.photo(r) : null;
    },
    async listWallEligible(limit: number, publicOnly = false) {
      const rows = await one(
        `select * from public.${publicOnly ? "wall_public_photos" : "wall_eligible_photos"}
          order by created_at desc limit $1`,
        [limit],
      );
      return rows.map((r) => ({
        id: r.id as string,
        createdAt: new Date(r.created_at as string).toISOString(),
        frameId: r.frame_id as string,
        mime: r.mime as PhotoRow["mime"],
        thumbPath: (r.thumb_path as string | null) ?? null,
        objectPath: r.object_path as string,
      }));
    },
  } as unknown as PhotoRepository;

  const settings: SettingsRepository = {
    async get() {
      const [r] = await one("select * from public.event_settings where id = 1", []);
      return fromDb.settings(r!);
    },
    async update(patch: SettingsPatch, staffUserId: string) {
      const { photoLooks, cameraEngine, ...rest } = patch;
      let changed: Row | undefined;
      if (photoLooks !== undefined) {
        [changed] = await one("select * from public.ftl_settings_set_looks($1,$2)", [
          photoLooks,
          staffUserId,
        ]);
      }
      if (cameraEngine !== undefined) {
        [changed] = await one("select * from public.ftl_settings_set_camera_engine($1,$2)", [
          JSON.stringify(cameraEngine),
          staffUserId,
        ]);
      }
      if (changed && Object.keys(rest).length === 0) return fromDb.settings(changed);
      const [r] = await one(
        "select * from public.ftl_settings_update($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [
          patch.pauseSubmissions ?? null,
          patch.pauseWall ?? null,
          patch.showHoldingScreen ?? null,
          patch.wallForce ?? null,
          patch.wallHours !== undefined,
          patch.wallHours?.start ?? null,
          patch.wallHours?.end ?? null,
          null,
          patch.wallPublic ?? null,
          patch.wallLook ? JSON.stringify(patch.wallLook) : null,
          patch.moderationMode ?? null,
          staffUserId,
        ],
      );
      return fromDb.settings(r!);
    },
  };

  const audit: AuditRepository = {
    async list(filter) {
      const rows = await one(
        `select * from public.audit_events
          where ($1::text is null or subject_type = $1) and ($2::text is null or subject_id = $2)
          order by id desc limit $3`,
        [filter.subjectType ?? null, filter.subjectId ?? null, filter.limit],
      );
      return rows.map(fromDb.audit);
    },
  };

  const aiReviews: AiReviewRepository = {
    async enqueue(photoId, nowIso, maxAttempts) {
      const [r] = await one("select public.ftl_ai_enqueue($1,$2,$3) as ok", [
        photoId,
        nowIso,
        maxAttempts,
      ]);
      return r!.ok === true;
    },
    async claim(input) {
      const rows = await one("select * from public.ftl_ai_claim($1,$2,$3,$4,$5)", [
        input.nowIso,
        input.leaseUntilIso,
        input.limit,
        input.maxAttempts,
        input.photoId ?? null,
      ]);
      return rows.map((r) => ({ photo: fromDb.photo(r), claim: r.ai_claim as string }));
    },
    async complete(c: AiCompletion) {
      const [r] = await one(
        "select public.ftl_ai_complete($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as r",
        [
          c.photoId,
          c.claim,
          c.outcome,
          c.reason,
          c.categories,
          c.provider,
          c.model,
          c.latencyMs,
          c.nextAttemptAt,
          c.called,
          c.nowIso,
          c.day,
        ],
      );
      const raw = r!.r as { applied: boolean; approved: boolean };
      return { applied: raw.applied === true, approved: raw.approved === true };
    },
    async takeBudget(day, limit) {
      const [r] = await one("select public.ftl_ai_budget_take($1,$2) as r", [day, limit]);
      const raw = r!.r as { allowed: boolean; used: number };
      return { allowed: raw.allowed === true, used: Number(raw.used) };
    },
    async status(day): Promise<AiReviewStatusView> {
      const [r] = await one("select public.ftl_ai_status($1) as r", [day]);
      const raw = r!.r as { usage: Row | null; pending: Record<string, number> };
      const u = raw.usage ?? {};
      const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
      return {
        usage: {
          day,
          requests: Number(u.requests ?? 0),
          succeeded: Number(u.succeeded ?? 0),
          failed: Number(u.failed ?? 0),
          approved: Number(u.approved ?? 0),
          flagged: Number(u.flagged ?? 0),
          lastSuccessAt: iso(u.last_success_at),
          lastFailureAt: iso(u.last_failure_at),
          lastFailureReason: (u.last_failure_reason as string | null) ?? null,
        },
        pending: Object.fromEntries(
          AI_REVIEW_STATES.map((s) => [s, Number(raw.pending?.[s] ?? 0)]),
        ) as AiReviewStatusView["pending"],
      };
    },
  };

  return { photos, settings, audit, aiReviews };
}
