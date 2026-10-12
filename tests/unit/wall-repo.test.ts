// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalBackend,
  flushLocalBackends,
  forgetLocalBackendsForTests,
} from "@/lib/storage/local-backend";
import { createMemoryBackend } from "@/lib/storage/memory-backend";
import type { StorageBackend } from "@/lib/storage/types";
import { uuid } from "../helpers/images";

/** Wall rotation state (exposure log + show-now) on the hub's backends. */
function wallContract(name: string, make: () => Promise<StorageBackend>) {
  describe(`wall repository: ${name}`, () => {
    it("counts each appearance and keeps first/last times", async () => {
      const b = await make();
      const [a, c] = [uuid(), uuid()];
      await b.wall.report({ shown: [a], onWall: [a], at: "2026-12-01T10:00:00.000Z" });
      await b.wall.report({ shown: [a, c], onWall: [a, c], at: "2026-12-01T10:05:00.000Z" });
      const byId = new Map((await b.wall.exposures())!.map((e) => [e.photoId, e]));
      expect(byId.get(a)).toEqual({
        photoId: a,
        shownCount: 2,
        firstShownAt: "2026-12-01T10:00:00.000Z",
        lastShownAt: "2026-12-01T10:05:00.000Z",
      });
      expect(byId.get(c)?.shownCount).toBe(1);
    });

    it("show-now: audited, oldest first, kept on repeat, cleared once shown or on screen", async () => {
      const b = await make();
      const staff = uuid();
      const [a, c, d] = [uuid(), uuid(), uuid()];
      const first = await b.wall.requestShowNow(a, staff);
      await new Promise((r) => setTimeout(r, 5));
      await b.wall.requestShowNow(c, staff);
      await b.wall.requestShowNow(d, staff);
      expect((await b.wall.requestShowNow(a, staff)).requestedAt).toBe(first.requestedAt);
      expect((await b.wall.showNowQueue()).map((r) => r.photoId)).toEqual([a, c, d]);

      await b.wall.report({ shown: [c], onWall: [d], at: new Date().toISOString() });
      expect((await b.wall.showNowQueue()).map((r) => r.photoId)).toEqual([a]);

      const audit = await b.audit.list({ subjectType: "photo", subjectId: a, limit: 5 });
      expect(audit[0]).toMatchObject({ action: "wall_show_now", actorId: staff });
    });
  });
}

wallContract("memory", async () => createMemoryBackend());

const dirs: string[] = [];
afterEach(async () => {
  forgetLocalBackendsForTests();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function localDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ftl-wall-"));
  dirs.push(dir);
  return dir;
}
wallContract("local files", async () => createLocalBackend(await localDir()));

describe("wall repository: local persistence", () => {
  it("exposure reports are saved lazily, show-now at once, and both survive a restart", async () => {
    const dir = await localDir();
    const b = createLocalBackend(dir);
    const [a, other, staff] = [uuid(), uuid(), uuid()];
    await b.settings.get(); // creates the file
    await b.wall.report({ shown: [a], onWall: [a], at: "2026-12-01T10:00:00.000Z" });
    const before = await readFile(path.join(dir, "db.json"), "utf8").catch(() => "");
    expect(before).not.toContain(a); // not written yet

    await b.wall.requestShowNow(a, staff); // an immediate write carries the exposure too
    const after = JSON.parse(await readFile(path.join(dir, "db.json"), "utf8"));
    expect(after.wallShowNow[0].photoId).toBe(a);
    expect(after.wallExposures[0].photoId).toBe(a);

    await b.wall.report({ shown: [other], onWall: [other], at: "2026-12-01T10:10:00.000Z" });
    await flushLocalBackends();
    forgetLocalBackendsForTests();
    const again = createLocalBackend(dir);
    const byId = new Map((await again.wall.exposures())!.map((e) => [e.photoId, e]));
    expect(byId.get(other)?.lastShownAt).toBe("2026-12-01T10:10:00.000Z");
    expect(byId.get(a)?.shownCount).toBe(1);
    expect((await again.wall.showNowQueue()).map((r) => r.photoId)).toEqual([a]);
  });
});
