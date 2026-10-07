import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MemoryKioskRepository, MemoryPhotoRepository } from "./memory-backend";
import type { KioskRow, ObjectStorage, PhotoRow, StorageBackend } from "./types";

/**
 * Files on disk, for development and a single self-hosted kiosk PC (PATH A on a LAN).
 *
 *   <root>/db.json            photo + kiosk rows (written atomically)
 *   <root>/objects/<path>     image bytes, private (served only through /p/[token]/image)
 *
 * Single-process only. Not for serverless (Vercel's filesystem is ephemeral).
 */
interface DbFile {
  version: 2;
  photos: PhotoRow[];
  kiosks: KioskRow[];
}

class FileDb {
  private loaded: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  readonly photos = new MemoryPhotoRepository();
  readonly kiosks = new MemoryKioskRepository();

  constructor(private readonly file: string) {}

  private async load() {
    try {
      const db = JSON.parse(await readFile(this.file, "utf8")) as DbFile;
      if (db.version === 2) {
        for (const p of db.photos) this.photos.rows.set(p.id, p);
        for (const k of db.kiosks) this.kiosks.rows.set(k.id, k);
      }
    } catch {
      // Missing or pre-Phase-2 file: start empty.
    }
  }

  private async save() {
    const db: DbFile = {
      version: 2,
      photos: [...this.photos.rows.values()],
      kiosks: [...this.kiosks.rows.values()],
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

export function createLocalBackend(rootDir: string): StorageBackend {
  const file = path.resolve(rootDir, "db.json");
  let db = registry.get(file);
  if (!db) {
    db = new FileDb(file);
    registry.set(file, db);
  }
  const read =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    (...a: A) =>
      db.run(() => fn(...a), false);
  const write =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    (...a: A) =>
      db.run(() => fn(...a), true);
  const p = db.photos;
  const k = db.kiosks;
  return {
    name: "local",
    photos: {
      findBySessionId: read(p.findBySessionId.bind(p)),
      findByTokenHash: read(p.findByTokenHash.bind(p)),
      insert: write(p.insert.bind(p)),
      update: write(p.update.bind(p)),
      listRetentionDue: read(p.listRetentionDue.bind(p)),
    },
    objects: new FileObjectStorage(path.join(rootDir, "objects")),
    kiosks: {
      insert: write(k.insert.bind(k)),
      get: read(k.get.bind(k)),
      revoke: write(k.revoke.bind(k)),
      touch: write(k.touch.bind(k)),
      list: read(k.list.bind(k)),
    },
  };
}

/** Tests only: simulate a process restart (drop in-memory copies; disk stays). */
export function forgetLocalBackendsForTests() {
  registry.clear();
}
