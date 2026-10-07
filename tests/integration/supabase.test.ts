// @vitest-environment node
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PhotoService } from "@/lib/storage/photo-service";
import { createSupabaseBackend } from "@/lib/storage/supabase-backend";
import type { StorageBackend } from "@/lib/storage/types";
import { JPEG, uuid } from "../helpers/images";
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
      await backend.kiosks.insert({
        id,
        label: "integration",
        createdAt: new Date().toISOString(),
        revokedAt: null,
        lastSeenAt: null,
      });
    }
  });

  photoServiceContract("supabase", async () => ({
    backend,
    kioskId: kioskA,
    otherKioskId: kioskB,
  }));

  describe("kiosk registry", () => {
    it("revokes and reports unknown kiosks", async () => {
      const id = uuid();
      await backend.kiosks.insert({
        id,
        label: "revoke me",
        createdAt: new Date().toISOString(),
        revokedAt: null,
        lastSeenAt: null,
      });
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

    it("authenticated role has no table privileges either", async () => {
      await client.query("begin");
      try {
        await client.query("set local role authenticated");
        await expect(client.query("select 1 from public.photos limit 1")).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await client.query("rollback");
      }
    });

    it("migration is re-runnable", async () => {
      const fs = await import("node:fs/promises");
      const sql = await fs.readFile(
        "supabase/migrations/20261007120000_phase2_photo_delivery.sql",
        "utf8",
      );
      await expect(client.query(sql)).resolves.toBeDefined();
    });
  });
});
