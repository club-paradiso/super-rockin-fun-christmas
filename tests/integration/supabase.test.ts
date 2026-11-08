// @vitest-environment node
import { newKioskRow } from "@/lib/storage/rows";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PhotoService } from "@/lib/storage/photo-service";
import { createSupabaseBackend } from "@/lib/storage/supabase-backend";
import type { StorageBackend } from "@/lib/storage/types";
import { JPEG, uuid } from "../helpers/images";
import { opsContract } from "../helpers/ops-contract";
import { photoServiceContract } from "../helpers/photo-contract";

/**
 * Real Supabase (local stack via `npm run test:supabase`, or CI). Skipped when not configured.
 * Proves the adapter, the migration, RLS and the private bucket — not just mocks.
 */
const URL_ = process.env.SUPABASE_TEST_URL;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const DB_URL = process.env.SUPABASE_TEST_DB_URL;
const enabled = !!(URL_ && SERVICE && ANON && DB_URL);

describe.skipIf(!enabled)("Supabase backend (integration)", () => {
  let backend: StorageBackend;
  const kioskA = uuid();
  const kioskB = uuid();

  beforeAll(async () => {
    backend = createSupabaseBackend({ url: URL_!, serviceRoleKey: SERVICE!, bucket: "photos" });
    for (const id of [kioskA, kioskB]) {
      await backend.kiosks.insert(newKioskRow(id, "integration", "secret"));
    }
  });

  photoServiceContract("supabase", async () => ({
    backend,
    kioskId: kioskA,
    otherKioskId: kioskB,
  }));

  const service = () => createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
  const newAuthUser = async () => {
    const email = `staff-${uuid()}@example.org`;
    const { data, error } = await service().auth.admin.createUser({ email, email_confirm: true });
    if (error) throw error;
    return { id: data.user.id, email };
  };
  opsContract("supabase", async () => ({
    backend,
    staffId: (await newAuthUser()).id,
    newUser: newAuthUser,
    objectExists: async (path) => !(await service().storage.from("photos").download(path)).error,
  }));

  describe("kiosk registry", () => {
    it("revokes and reports unknown kiosks", async () => {
      const id = uuid();
      await backend.kiosks.insert(newKioskRow(id, "revoke me", "secret"));
      expect(await backend.kiosks.revoke(id, new Date().toISOString())).toBe(true);
      expect((await backend.kiosks.get(id))!.revokedAt).not.toBeNull();
      expect(await backend.kiosks.revoke(uuid(), new Date().toISOString())).toBe(false);
    });
  });

  describe("least privilege (anon key in a browser cannot reach photos)", () => {
    let objectPath: string;
    let anon: ReturnType<typeof createClient>;

    beforeAll(async () => {
      const svc = new PhotoService(backend, { linkTtlHours: 72, retentionDays: 30 });
      await svc.put({
        sessionId: uuid(),
        kioskId: kioskA,
        frameId: "starlight-strip",
        mime: "image/jpeg",
        data: JPEG,
      });
      const service = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
      const { data } = await service.from("photos").select("object_path").limit(1).single();
      objectPath = (data as { object_path: string }).object_path;
      anon = createClient(URL_!, ANON!, { auth: { persistSession: false } });
    });

    it("bucket is private", async () => {
      const service = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
      const { data } = await service.storage.getBucket("photos");
      expect(data!.public).toBe(false);
      const publicUrl = `${URL_}/storage/v1/object/public/photos/${objectPath}`;
      expect((await fetch(publicUrl)).ok).toBe(false);
    });

    it("anon cannot read, write or list photos rows", async () => {
      const read = await anon.from("photos").select("*");
      expect(read.error ?? (read.data as unknown[]).length === 0).toBeTruthy();
      expect(read.data ?? []).toEqual([]);
      const write = await anon.from("photos").insert({ id: uuid() } as never);
      expect(write.error).not.toBeNull();
      const kiosks = await anon.from("kiosks").select("*");
      expect(kiosks.data ?? []).toEqual([]);
    });

    it("anon cannot download, sign, list or upload objects", async () => {
      expect((await anon.storage.from("photos").download(objectPath)).error).not.toBeNull();
      expect(
        (await anon.storage.from("photos").createSignedUrl(objectPath, 60)).error,
      ).not.toBeNull();
      const list = await anon.storage.from("photos").list(objectPath.split("/")[0]);
      expect(list.data ?? []).toEqual([]);
      expect(
        (
          await anon.storage
            .from("photos")
            .upload(`x/${uuid()}.jpg`, JPEG, { contentType: "image/jpeg" })
        ).error,
      ).not.toBeNull();
    });
  });

  describe("schema constraints (direct SQL)", () => {
    let client: pg.Client;
    beforeAll(async () => {
      client = new pg.Client({ connectionString: DB_URL });
      await client.connect();
    });
    afterAll(() => client.end());

    const insert = (over: Record<string, unknown> = {}) => {
      const row = {
        id: uuid(),
        session_id: uuid(),
        frame_id: "starlight-strip",
        mime: "image/jpeg",
        bytes: 10,
        object_path: `t/${uuid()}.jpg`,
        token_hash: "a"
          .repeat(64)
          .replace(/a/g, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]!),
        token_expires_at: "2026-12-27T00:00:00Z",
        retention_expires_at: "2027-01-23T00:00:00Z",
        ...over,
      };
      const cols = Object.keys(row);
      return client.query(
        `insert into public.photos (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
        Object.values(row),
      );
    };

    it("defaults moderation to NONE and consent to false", async () => {
      const session = uuid();
      await insert({ session_id: session });
      const { rows } = await client.query(
        "select moderation_status, wall_consent from photos where session_id=$1",
        [session],
      );
      expect(rows[0]).toEqual({ moderation_status: "NONE", wall_consent: false });
    });

    it.each([
      [
        "duplicate session",
        async (s: string) => (await insert({ session_id: s }), { session_id: s }),
      ],
      ["bad token hash", async () => ({ token_hash: "not-a-hash" })],
      [
        "retention before link expiry",
        async () => ({ retention_expires_at: "2026-01-01T00:00:00Z" }),
      ],
      ["approved without consent", async () => ({ moderation_status: "APPROVED" })],
      ["path traversal", async () => ({ object_path: "../etc/passwd" })],
      ["oversized", async () => ({ bytes: 5_000_000 })],
    ])("rejects %s", async (_, makeOver) => {
      const over = await makeOver(uuid());
      await expect(insert(over)).rejects.toThrow();
    });

    const PRIVATE_TABLES = [
      "photos",
      "kiosks",
      "staff_members",
      "audit_events",
      "kiosk_enrollment_codes",
      "event_settings",
      "retention_runs",
      "wall_eligible_photos",
    ];

    it.each(["anon", "authenticated"])(
      "%s role has no access to any FOLLOW THE LIGHTS table",
      async (role) => {
        for (const table of PRIVATE_TABLES) {
          await client.query("begin");
          try {
            await client.query(`set local role ${role}`);
            await expect(client.query(`select 1 from public.${table} limit 1`)).rejects.toThrow(
              /permission denied/,
            );
          } finally {
            await client.query("rollback");
          }
        }
      },
    );

    it.each(["anon", "authenticated"])(
      "%s role cannot call the audited mutation functions",
      async (role) => {
        await client.query("begin");
        try {
          await client.query(`set local role ${role}`);
          await expect(
            client.query(
              "select public.ftl_settings_update(true, null, null, null, false, null, null, null, gen_random_uuid())",
            ),
          ).rejects.toThrow(/permission denied/);
        } finally {
          await client.query("rollback");
        }
      },
    );

    it("there is exactly one settings function (the pre-2-4b signature is gone)", async () => {
      const { rows } = await client.query(
        "select pg_get_function_identity_arguments(p.oid) as args from pg_proc p " +
          "join pg_namespace n on n.oid = p.pronamespace " +
          "where n.nspname = 'public' and p.proname = 'ftl_settings_update'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].args).toMatch(/p_wall_force text/);
    });

    it("audit_events is append-only, even for the database owner", async () => {
      const { rows } = await client.query("select id from public.audit_events limit 1");
      expect(rows.length).toBe(1);
      await expect(
        client.query("update public.audit_events set note = 'x' where id = $1", [rows[0].id]),
      ).rejects.toThrow(/append-only/);
      await expect(
        client.query("delete from public.audit_events where id = $1", [rows[0].id]),
      ).rejects.toThrow(/append-only/);
    });

    it("DELETED is terminal at the database level", async () => {
      const session = uuid();
      await insert({ session_id: session });
      await client.query(
        "update public.photos set moderation_status = 'DELETED', deleted_at = now() where session_id = $1",
        [session],
      );
      await expect(
        client.query(
          "update public.photos set moderation_status = 'PENDING' where session_id = $1",
          [session],
        ),
      ).rejects.toThrow(/terminal/);
    });

    it("migrations are re-runnable", async () => {
      const fs = await import("node:fs/promises");
      for (const file of (await fs.readdir("supabase/migrations")).sort()) {
        const sql = await fs.readFile(`supabase/migrations/${file}`, "utf8");
        await expect(client.query(sql)).resolves.toBeDefined();
      }
    });
  });
});
