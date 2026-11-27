// @vitest-environment node
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultCameraEngine, type CameraEngineSettings } from "@/lib/camera-engine/settings";
import type { CameraEngineStatus } from "@/lib/camera-engine/status";
import { fromDb } from "@/lib/storage/supabase-backend";
import { uuid } from "../helpers/images";
import { createPgAiBackend } from "../helpers/pg-backend";

/**
 * The camera-engine migration on a real Postgres: its two columns, its function, its audit row
 * and its grants. Runs against any database that has supabase/migrations applied (see
 * tests/integration/ai-review-sql.test.ts and docs/SUPABASE.md); skipped when no URL is set.
 * Everything the application would do runs as `service_role`.
 */
const DB_URL = process.env.FTL_TEST_PG_URL || process.env.SUPABASE_TEST_DB_URL;
const MIGRATION = path.resolve(
  import.meta.dirname,
  "../../supabase/migrations/20261127090000_camera_engine.sql",
);

describe.skipIf(!DB_URL)("camera engine SQL (integration)", () => {
  let db: pg.Pool;
  let owner: pg.Pool;
  beforeAll(() => {
    db = new pg.Pool({ connectionString: DB_URL, max: 2, options: "-c role=service_role" });
    owner = new pg.Pool({ connectionString: DB_URL, max: 1 });
  });
  afterAll(async () => {
    // Leave the shared settings row as the migration made it.
    await owner?.query("update public.event_settings set camera_engine = null where id = 1");
    await Promise.all([db?.end(), owner?.end()]);
  });

  const manual: CameraEngineSettings = {
    ...defaultCameraEngine(),
    mode: "manual",
    perspective: false,
    rollOffset: -2.5,
    pitchOffset: 8,
    fov: 62.5,
    calibration: 3,
  };

  it("the migration can be applied again; without a stored value the setting reads as off", async () => {
    await owner.query("update public.event_settings set camera_engine = null where id = 1");
    await owner.query(await readFile(MIGRATION, "utf8"));
    await owner.query(await readFile(MIGRATION, "utf8"));
    const { settings } = createPgAiBackend(db);
    expect((await settings.get()).cameraEngine).toEqual(defaultCameraEngine());
  });

  it("stores the whole setting and writes the audit row in the same call", async () => {
    const { settings, audit } = createPgAiBackend(db);
    const staffId = uuid();
    const auto = { ...defaultCameraEngine(), mode: "auto" as const };
    expect(await settings.update({ cameraEngine: auto }, staffId)).toMatchObject({
      cameraEngine: auto,
      updatedBy: staffId,
    });
    expect((await settings.update({ cameraEngine: manual }, staffId)).cameraEngine).toEqual(manual);
    expect((await settings.get()).cameraEngine).toEqual(manual);
    const [last] = await audit.list({ subjectType: "settings", limit: 1 });
    expect(last).toMatchObject({ action: "update_settings", actorId: staffId });
    expect(JSON.parse(last!.fromState!)).toEqual({ camera_engine: auto });
    expect(JSON.parse(last!.toState!)).toEqual({ camera_engine: manual });
    // The general settings function knows nothing of the column and leaves it alone.
    expect((await settings.update({ pauseWall: true }, staffId)).cameraEngine).toEqual(manual);
    const both = await settings.update(
      { cameraEngine: defaultCameraEngine(), pauseWall: false },
      staffId,
    );
    expect(both).toMatchObject({ cameraEngine: defaultCameraEngine(), pauseWall: false });
  });

  it("refuses a value that is not an object, and leaves no audit row for it", async () => {
    const count = async () =>
      Number(
        (
          await db.query(
            "select count(*) as n from public.audit_events where subject_type = 'settings'",
          )
        ).rows[0].n,
      );
    const before = await count();
    for (const bad of ["null", '"auto"', "[1]", "3"])
      await expect(
        db.query("select * from public.ftl_settings_set_camera_engine($1::jsonb, $2)", [
          bad,
          uuid(),
        ]),
        bad,
      ).rejects.toThrow(/json object/);
    await expect(
      db.query("select * from public.ftl_settings_set_camera_engine(null, $1)", [uuid()]),
    ).rejects.toThrow(/json object/);
    expect(await count()).toBe(before);
  });

  it("only service_role may call the function", async () => {
    for (const role of ["anon", "authenticated"]) {
      const client = await owner.connect();
      try {
        await client.query(`set role ${role}`);
        await expect(
          client.query("select * from public.ftl_settings_set_camera_engine($1::jsonb, $2)", [
            JSON.stringify(manual),
            uuid(),
          ]),
          role,
        ).rejects.toThrow(/permission denied/);
      } finally {
        await client.query("reset role");
        client.release();
      }
    }
  });

  it("a kiosk row keeps the booth's status as an object, or nothing", async () => {
    const id = uuid();
    const status: CameraEngineStatus = {
      state: "full",
      reason: null,
      permission: "granted",
      sensor: "ok",
      backend: "webgl",
      roll: 3,
      pitch: 6,
      appliedRoll: 3,
      appliedPitch: 4.2,
      strength: 0.71,
      zoom: 1.07,
      loss: 0.08,
      confidence: 0.99,
      profile: "generic-front",
      profileSource: "assumed",
      locked: false,
      previewMatches: true,
      pitchWarning: false,
      error: null,
    };
    await db.query("insert into public.kiosks (id, label) values ($1, 'camera engine sql')", [id]);
    try {
      const row = async () =>
        fromDb.kiosk((await db.query("select * from public.kiosks where id = $1", [id])).rows[0]);
      expect((await row()).cameraEngine).toBeNull();
      await db.query("update public.kiosks set camera_engine = $2::jsonb where id = $1", [
        id,
        JSON.stringify(status),
      ]);
      expect((await row()).cameraEngine).toEqual(status);
      // Something this build cannot read is shown as nothing, never as it is.
      await db.query("update public.kiosks set camera_engine = $2::jsonb where id = $1", [
        id,
        JSON.stringify({ ...status, state: "perfect" }),
      ]);
      expect((await row()).cameraEngine).toBeNull();
      await expect(
        db.query(`update public.kiosks set camera_engine = '"full"'::jsonb where id = $1`, [id]),
      ).rejects.toThrow(/kiosks_camera_engine_check/);
      await db.query("update public.kiosks set camera_engine = null where id = $1", [id]);
      expect((await row()).cameraEngine).toBeNull();
    } finally {
      await db.query("delete from public.kiosks where id = $1", [id]);
    }
  });
});
