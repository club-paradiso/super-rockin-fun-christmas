/**
 * Durable storage for finished photos that have not reached the server yet. IndexedDB so the
 * JPEG survives reloads and browser restarts. Bytes are stored as ArrayBuffer (more portable
 * across older Safari versions than Blob).
 */

export interface QueuedUpload {
  /** Kiosk session id — also the server's idempotency key and this store's primary key. */
  sessionId: string;
  frameId: string;
  mime: "image/jpeg" | "image/png";
  data: ArrayBuffer;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  /** "auth": the server said this kiosk is not enrolled; retried slowly until re-enrolled. */
  state: "pending" | "auth";
}

export interface QueueStore {
  all(): Promise<QueuedUpload[]>;
  get(sessionId: string): Promise<QueuedUpload | null>;
  put(entry: QueuedUpload): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export class MemoryQueueStore implements QueueStore {
  private readonly entries = new Map<string, QueuedUpload>();
  async all() {
    return [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
  async get(id: string) {
    return this.entries.get(id) ?? null;
  }
  async put(e: QueuedUpload) {
    this.entries.set(e.sessionId, { ...e });
  }
  async delete(id: string) {
    this.entries.delete(id);
  }
}

const DB_NAME = "follow-the-lights";
const STORE = "uploads";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IndexedDbQueueStore implements QueueStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory: IDBFactory = indexedDB,
    private readonly dbName = DB_NAME,
  ) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = this.factory.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE))
          db.createObjectStore(STORE, { keyPath: "sessionId" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    });
    return this.db;
  }

  private async tx(mode: IDBTransactionMode) {
    return (await this.open()).transaction(STORE, mode).objectStore(STORE);
  }

  async all() {
    const rows = await request((await this.tx("readonly")).getAll() as IDBRequest<QueuedUpload[]>);
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }
  async get(id: string) {
    return (
      ((await request((await this.tx("readonly")).get(id))) as QueuedUpload | undefined) ?? null
    );
  }
  async put(e: QueuedUpload) {
    await request((await this.tx("readwrite")).put(e));
  }
  async delete(id: string) {
    await request((await this.tx("readwrite")).delete(id));
  }

  close() {
    void this.db?.then((d) => d.close());
    this.db = null;
  }
}

/** IndexedDB when available and working, otherwise memory (e.g. some private-browsing modes). */
export async function openQueueStore(): Promise<{ store: QueueStore; durable: boolean }> {
  if (typeof indexedDB !== "undefined") {
    const store = new IndexedDbQueueStore();
    try {
      await store.all();
      return { store, durable: true };
    } catch {
      // fall through
    }
  }
  return { store: new MemoryQueueStore(), durable: false };
}
