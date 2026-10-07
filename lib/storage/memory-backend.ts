import type {
  KioskRepository,
  KioskRow,
  ObjectStorage,
  PhotoRepository,
  PhotoRow,
  StorageBackend,
} from "./types";

/** In-memory backend. Used by tests, and as the reference behaviour for the other backends. */
export class MemoryPhotoRepository implements PhotoRepository {
  readonly rows = new Map<string, PhotoRow>();

  async findBySessionId(sessionId: string) {
    return clone([...this.rows.values()].find((r) => r.sessionId === sessionId));
  }
  async findByTokenHash(tokenHash: string) {
    return clone([...this.rows.values()].find((r) => r.tokenHash === tokenHash));
  }
  async insert(row: PhotoRow) {
    if ([...this.rows.values()].some((r) => r.sessionId === row.sessionId))
      return "conflict" as const;
    if ([...this.rows.values()].some((r) => r.tokenHash === row.tokenHash))
      throw new Error("token_hash collision");
    this.rows.set(row.id, { ...row });
    return "inserted" as const;
  }
  async update(id: string, patch: Partial<PhotoRow>) {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...patch, updatedAt: new Date().toISOString() };
    this.rows.set(id, next);
    return { ...next };
  }
  async listRetentionDue(nowIso: string, limit: number) {
    return [...this.rows.values()]
      .filter((r) => r.deletedAt === null && r.retentionExpiresAt <= nowIso)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}

export class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, Uint8Array>();
  failRemove = false;

  async put(path: string, data: Uint8Array) {
    if (this.objects.has(path)) throw new Error("object exists");
    this.objects.set(path, data.slice());
  }
  async get(path: string) {
    return this.objects.get(path)?.slice() ?? null;
  }
  async remove(path: string) {
    if (this.failRemove) throw new Error("storage unavailable");
    this.objects.delete(path);
  }
}

export class MemoryKioskRepository implements KioskRepository {
  readonly rows = new Map<string, KioskRow>();
  async insert(row: KioskRow) {
    this.rows.set(row.id, { ...row });
  }
  async get(id: string) {
    return clone(this.rows.get(id));
  }
  async revoke(id: string, atIso: string) {
    const row = this.rows.get(id);
    if (!row) return false;
    row.revokedAt ??= atIso;
    return true;
  }
  async touch(id: string, atIso: string) {
    const row = this.rows.get(id);
    if (row) row.lastSeenAt = atIso;
  }
  async list() {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
}

function clone<T extends object>(v: T | undefined): T | null {
  return v ? { ...v } : null;
}

export function createMemoryBackend(): StorageBackend & {
  photos: MemoryPhotoRepository;
  objects: MemoryObjectStorage;
  kiosks: MemoryKioskRepository;
} {
  return {
    name: "memory",
    photos: new MemoryPhotoRepository(),
    objects: new MemoryObjectStorage(),
    kiosks: new MemoryKioskRepository(),
  };
}
