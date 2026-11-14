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
const CONSENT_STORE = "consents";
/** v2 added the consent store. Upgrading keeps every queued photo. */
const DB_VERSION = 2;

/**
 * The guest's media-wall answer for a session, kept until the hub has it (AUDIT R1/R2: it used to
 * be sent once, and only if the QR was already showing).
 */
/** What a wall consent covers beyond the venue screen. Only one wider scope exists. */
export type ConsentScope = "public";

export interface QueuedConsent {
  sessionId: string;
  consent: boolean;
  /**
   * "public": the consent screen showed the public-wall notice when the guest answered (D86).
   * Absent = the venue wall only (also every answer queued before D86).
   */
  scope?: ConsentScope;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
}

export interface ConsentStore {
  all(): Promise<QueuedConsent[]>;
  put(entry: QueuedConsent): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export class MemoryConsentStore implements ConsentStore {
  private readonly entries = new Map<string, QueuedConsent>();
  async all() {
    return [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
  async put(e: QueuedConsent) {
    this.entries.set(e.sessionId, { ...e });
  }
  async delete(id: string) {
    this.entries.delete(id);
  }
}

function openDb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE))
        db.createObjectStore(STORE, { keyPath: "sessionId" });
      if (!db.objectStoreNames.contains(CONSENT_STORE))
        db.createObjectStore(CONSENT_STORE, { keyPath: "sessionId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

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
    this.db ??= openDb(this.factory, this.dbName);
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

export class IndexedDbConsentStore implements ConsentStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory: IDBFactory = indexedDB,
    private readonly dbName = DB_NAME,
  ) {}

  private async tx(mode: IDBTransactionMode) {
    this.db ??= openDb(this.factory, this.dbName);
    return (await this.db).transaction(CONSENT_STORE, mode).objectStore(CONSENT_STORE);
  }

  async all() {
    const rows = await request((await this.tx("readonly")).getAll() as IDBRequest<QueuedConsent[]>);
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }
  async put(e: QueuedConsent) {
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
export async function openQueueStore(): Promise<{
  store: QueueStore;
  consents: ConsentStore;
  durable: boolean;
}> {
  if (typeof indexedDB !== "undefined") {
    const store = new IndexedDbQueueStore();
    const consents = new IndexedDbConsentStore();
    try {
      await store.all();
      await consents.all();
      return { store, consents, durable: true };
    } catch {
      // fall through
    }
  }
  return { store: new MemoryQueueStore(), consents: new MemoryConsentStore(), durable: false };
}
