// @vitest-environment node
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiReviewContract } from "../helpers/ai-contract";
import { uuid } from "../helpers/images";
import { createPgAiBackend } from "../helpers/pg-backend";

/**
 * The D95 migration on a real Postgres: its functions, its trigger and its grants. Runs against
 * any database that has supabase/migrations applied: the local Supabase stack
 * (`npm run test:supabase` sets SUPABASE_TEST_DB_URL), or a plain Postgres with the three
 * Supabase roles (FTL_TEST_PG_URL; docs/SUPABASE.md says how). Skipped when neither is set.
 *
 * The URL is the database owner's (it re-applies the migration). Everything the application
 * would do runs as `service_role`, the role the deployment really uses, so a missing grant fails
 * here and not at the event.
 */
const DB_URL = process.env.FTL_TEST_PG_URL || process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!DB_URL)("AI review SQL (integration)", () => {
  let db: pg.Pool;
  let owner: pg.Pool;
  beforeAll(() => {
    db = new pg.Pool({ connectionString: DB_URL, max: 4, options: "-c role=service_role" });
    owner = new pg.Pool({ connectionString: DB_URL, max: 1 });
  });
  afterAll(() => Promise.all([db?.end(), owner?.end()]));

  aiReviewContract("postgres functions", async () => ({
    backend: createPgAiBackend(db),
    staffId: uuid(),
  }));

  const scalar = async <T>(sql: string, args: unknown[] = []) =>
    (await db.query(sql, args)).rows[0] as T;

  it("the migration can be applied again without changing anything", async () => {
    const file = path.resolve(
      import.meta.dirname,
      "../../supabase/migrations/20261114120000_ai_review.sql",
    );
    const before = await scalar<{ n: string }>("select count(*) as n from public.photos");
    await owner.query(await readFile(file, "utf8"));
    await owner.query(await readFile(file, "utf8"));
    expect(await scalar("select count(*) as n from public.photos")).toEqual(before);
    // And the application role cannot change the schema or the rules itself.
    await expect(db.query("alter table public.photos drop column ai_status")).rejects.toThrow(
      /owner/,
    );
  });

  it("runs as service_role", async () => {
    expect(await scalar("select current_user as u")).toEqual({ u: "service_role" });
  });

  it("applying it turns nothing on: the mode defaults to manual, every photo to NONE", async () => {
    const col = async (table: string, column: string) =>
      (
        await scalar<{ d: string }>(
          `select column_default as d from information_schema.columns
            where table_schema = 'public' and table_name = $1 and column_name = $2`,
          [table, column],
        )
      ).d;
    expect(await col("event_settings", "moderation_mode")).toContain("manual");
    expect(await col("photos", "ai_status")).toContain("NONE");
  });

  it("anon and authenticated can neither call the functions nor read the usage table", async () => {
    const fns = [
      "public.ftl_ai_enqueue(uuid, timestamptz, integer)",
      "public.ftl_ai_claim(timestamptz, timestamptz, integer, integer, uuid)",
      "public.ftl_ai_complete(uuid, uuid, text, text, text[], text, text, integer, timestamptz, boolean, timestamptz, date)",
      "public.ftl_ai_budget_take(date, integer)",
      "public.ftl_ai_status(date)",
      "public.ftl_settings_update(boolean, boolean, boolean, text, boolean, text, text, text, boolean, jsonb, text, uuid)",
    ];
    for (const role of ["anon", "authenticated"]) {
      for (const fn of fns) {
        const { ok } = await scalar<{ ok: boolean }>(
          "select has_function_privilege($1, $2, 'execute') as ok",
          [role, fn],
        );
        expect(ok, `${role} ${fn}`).toBe(false);
      }
      const { ok } = await scalar<{ ok: boolean }>(
        "select has_table_privilege($1, 'public.ai_usage', 'select') as ok",
        [role],
      );
      expect(ok, `${role} ai_usage`).toBe(false);
    }
    for (const fn of fns) {
      const { ok } = await scalar<{ ok: boolean }>(
        "select has_function_privilege('service_role', $1, 'execute') as ok",
        [fn],
      );
      expect(ok, `service_role ${fn}`).toBe(true);
    }
    const { rls } = await scalar<{ rls: boolean }>(
      "select relrowsecurity as rls from pg_class where oid = 'public.ai_usage'::regclass",
    );
    expect(rls).toBe(true);
  });

  it("the wall views expose no AI column", async () => {
    const { rows } = await db.query(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and table_name in ('wall_eligible_photos', 'wall_public_photos')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r: { column_name: string }) => r.column_name.startsWith("ai_"))).toEqual(
      [],
    );
  });

  it("the settings signature the previous release calls still works and leaves the mode alone", async () => {
    const staff = uuid();
    const backend = createPgAiBackend(db);
    await backend.settings.update({ moderationMode: "auto" }, staff);
    const { rows } = await db.query(
      "select * from public.ftl_settings_update($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [null, null, null, null, false, null, null, null, null, null, staff],
    );
    expect(rows[0].moderation_mode).toBe("auto");
    await backend.settings.update({ moderationMode: "manual" }, staff);
    expect((await backend.settings.get()).moderationMode).toBe("manual");
  });

  it("the database itself refuses an unknown outcome and an unknown mode", async () => {
    await expect(
      db.query(
        "select public.ftl_ai_complete($1,$2,'APPROVE',null,'{}',null,null,null,null,false,now(),current_date)",
        [uuid(), uuid()],
      ),
    ).rejects.toThrow(/unknown AI outcome/);
    await expect(
      db.query("update public.event_settings set moderation_mode = 'unmoderated' where id = 1"),
    ).rejects.toThrow(/check/i);
    await expect(
      db.query(
        "update public.photos set ai_status = 'APPROVED' where false or ai_status = 'NONE' and id = $1",
        [uuid()],
      ),
    ).resolves.toBeDefined();
  });
});
