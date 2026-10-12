import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createMemoryBackend, type MemoryBackend } from "./memory-backend";
import type {
  AuditEvent,
  EnrollmentCodeRow,
  EventSettings,
  KioskRow,
  ObjectStorage,
  PhotoRow,
  RetentionRun,
  StaffMember,
  StaffPin,
  StorageBackend,
} from "./types";

/**
 * Files on disk, for development and a single self-hosted kiosk PC (PATH A on a LAN).
 *
 *   <root>/db.json            all rows (written atomically after every write)
 *   <root>/objects/<path>     image bytes, private (served only through the server)
 *
 * Wraps the memory backend: one serialized operation = one audited mutation + one save, so a
 * change and its audit event are persisted together. Single-process only; not for serverless.
 */
interface DbFile {
  version: 3;
  photos: PhotoRow[];
  kiosks: KioskRow[];
  enrollmentCodes: EnrollmentCodeRow[];
  settings: EventSettings | null;
  staff: StaffMember[];
  /** Hub PIN hashes by staff userId (absent in files written before the hub existed). */
  staffPins?: Record<string, StaffPin>;
  audit: AuditEvent[];
  retentionRuns: RetentionRun[];
}

class FileDb {
  private loaded: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  readonly mem: MemoryBackend = createMemoryBackend();

  constructor(private readonly file: string) {}

  private async load() {
    let db: Partial<Omit<DbFile, "version">> & { version?: number };
    try {
      db = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      return; // missing file: start empty
    }
    if (db.version !== 2 && db.version !== 3) return;
    // Phase 2 files (version 2) lack the Phase 3 fields; fill safe defaults.
    for (const p of db.photos ?? []) {
      this.mem.photos.rows.set(p.id, {
        ...p,
        thumbPath: p.thumbPath ?? null,
        objectDeletedAt: p.objectDeletedAt ?? null,
      });
    }
    for (const k of db.kiosks ?? []) {
      this.mem.kiosks.rows.set(k.id, {
        ...k,
        heartbeatAt: k.heartbeatAt ?? null,
        queueDepth: k.queueDepth ?? null,
        cameraState: k.cameraState ?? null,
        appBuild: k.appBuild ?? null,
        enrolledVia: k.enrolledVia ?? "secret",
      });
    }
    for (const c of db.enrollmentCodes ?? []) this.mem.enrollmentCodes.rows.set(c.id, c);
    if (db.settings) this.mem.settings.value = db.settings;
    for (const m of db.staff ?? []) this.mem.staff.rows.set(m.userId, m);
    for (const [id, pin] of Object.entries(db.staffPins ?? {})) this.mem.staff.pins.set(id, pin);
    this.mem.audit.load(db.audit ?? []);
    this.mem.retentionRuns.runs.push(...(db.retentionRuns ?? []));
  }

  private async save() {
    const m = this.mem;
    const db: DbFile = {
      version: 3,
      photos: [...m.photos.rows.values()],
      kiosks: [...m.kiosks.rows.values()],
      enrollmentCodes: [...m.enrollmentCodes.rows.values()],
      settings: m.settings.value,
      staff: [...m.staff.rows.values()],
      staffPins: Object.fromEntries(m.staff.pins),
      audit: m.audit.events,
      retentionRuns: m.retentionRuns.runs,
    };
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(db));
    await rename(tmp, this.file);
  }

  /** Serialize every operation; persist after writes. */
  run<T>(fn: () => Promise<T>, write: boolean): Promise<T> {
    this.loaded ??= this.load();
    const next = this.queue.then(async () => {
      await this.loaded;
      const result = await fn();
      if (write) await this.save();
      return result;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

class FileObjectStorage implements ObjectStorage {
  constructor(private readonly root: string) {}
  private resolve(p: string) {
    const full = path.resolve(this.root, p);
    if (!full.startsWith(path.resolve(this.root) + path.sep))
      throw new Error("path escapes storage root");
    return full;
  }
  async put(p: string, data: Uint8Array) {
    const full = this.resolve(p);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data, { flag: "wx" });
  }
  async get(p: string) {
    try {
      return new Uint8Array(await readFile(this.resolve(p)));
    } catch {
      return null;
    }
  }
  async remove(p: string) {
    await rm(this.resolve(p), { force: true });
  }
}

/**
 * Next.js bundles each route separately, so module-level singletons are duplicated per route.
 * Two FileDb instances on one file would each hold a stale copy and overwrite each other's
 * writes; keep exactly one per file for the whole process.
 */
const registry = ((globalThis as { __ftlFileDbs?: Map<string, FileDb> }).__ftlFileDbs ??=
  new Map());

/** Wrap every method of a repository so it runs serialized; listed methods also persist. */
function wrap<T extends object>(db: FileDb, repo: T, writes: (keyof T)[]): T {
  const out = {} as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(repo)) as (keyof T &
    string)[]) {
    const fn = repo[key];
    if (key === "constructor" || typeof fn !== "function") continue;
    out[key] = (...args: unknown[]) =>
      db.run(
        () => (fn as (...a: unknown[]) => Promise<unknown>).apply(repo, args),
        writes.includes(key),
      );
  }
  return out as T;
}

export function createLocalBackend(rootDir: string): StorageBackend {
  const file = path.resolve(rootDir, "db.json");
  let db = registry.get(file);
  if (!db) {
    db = new FileDb(file);
    registry.set(file, db);
  }
  const m = db.mem;
  return {
    name: "local",
    photos: wrap(db, m.photos, [
      "insert",
      "update",
      "transition",
      "rotateToken",
      "setThumbPath",
      "markObjectsDeleted",
    ]),
    objects: new FileObjectStorage(path.join(rootDir, "objects")),
    kiosks: wrap(db, m.kiosks, ["insert", "revoke", "touch", "heartbeat", "update"]),
    enrollmentCodes: wrap(db, m.enrollmentCodes, ["create", "consume"]),
    settings: wrap(db, m.settings, ["update"]),
    staff: wrap(db, m.staff, ["upsert", "setPin"]),
    audit: wrap(db, m.audit, []),
    retentionRuns: wrap(db, m.retentionRuns, ["record"]),
  };
}

/** Tests only: simulate a process restart (drop in-memory copies; disk stays). */
export function forgetLocalBackendsForTests() {
  registry.clear();
}
