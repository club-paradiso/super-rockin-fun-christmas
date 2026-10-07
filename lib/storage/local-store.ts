import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hashToken, isWellFormedToken, newToken } from "./token";
import type { PhotoRecord, PhotoStore, PutPhotoInput, PutPhotoResult } from "./types";

interface StoredMeta {
  record: PhotoRecord;
  tokenHash: string;
}

interface SessionIndex {
  /** The issued token, kept only so an idempotent retry can return the same link. */
  token: string;
}

export interface LocalPhotoStoreOptions {
  rootDir: string;
  linkTtlHours: number;
  now?: () => Date;
}

/**
 * Photos on local disk. For PATH A (single self-built kiosk) and development.
 *
 *   <root>/photos/<tokenHash>.jpg     image bytes
 *   <root>/photos/<tokenHash>.json    PhotoRecord
 *   <root>/sessions/<sessionId>.json  idempotency index
 */
export class LocalPhotoStore implements PhotoStore {
  private readonly now: () => Date;

  constructor(private readonly opts: LocalPhotoStoreOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  private photoPath(tokenHash: string, ext: "json" | "img") {
    return path.join(this.opts.rootDir, "photos", `${tokenHash}.${ext}`);
  }

  private sessionPath(sessionId: string) {
    return path.join(this.opts.rootDir, "sessions", `${sessionId}.json`);
  }

  async put(input: PutPhotoInput): Promise<PutPhotoResult> {
    // Idempotency: a kiosk retrying after a dropped response gets the same link, not a twin.
    const existing = await readJson<SessionIndex>(this.sessionPath(input.sessionId));
    if (existing) {
      const record = await this.get(existing.token);
      if (record) return { token: existing.token, record, duplicate: true };
    }

    const token = newToken();
    const tokenHash = hashToken(token);
    const created = this.now();
    const record: PhotoRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      frameId: input.frameId,
      mime: input.mime,
      bytes: input.data.byteLength,
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + this.opts.linkTtlHours * 3_600_000).toISOString(),
      wall: "none",
    };
    await mkdir(path.join(this.opts.rootDir, "photos"), { recursive: true });
    await mkdir(path.join(this.opts.rootDir, "sessions"), { recursive: true });
    await atomicWrite(this.photoPath(tokenHash, "img"), input.data);
    await atomicWrite(
      this.photoPath(tokenHash, "json"),
      JSON.stringify({ record, tokenHash } satisfies StoredMeta),
    );
    await atomicWrite(
      this.sessionPath(input.sessionId),
      JSON.stringify({ token } satisfies SessionIndex),
    );
    return { token, record, duplicate: false };
  }

  private async meta(token: string): Promise<StoredMeta | null> {
    if (!isWellFormedToken(token)) return null;
    const meta = await readJson<StoredMeta>(this.photoPath(hashToken(token), "json"));
    if (!meta) return null;
    if (new Date(meta.record.expiresAt).getTime() <= this.now().getTime()) return null;
    if (meta.record.wall === "DELETED") return null;
    return meta;
  }

  async get(token: string): Promise<PhotoRecord | null> {
    return (await this.meta(token))?.record ?? null;
  }

  async read(token: string) {
    const meta = await this.meta(token);
    if (!meta) return null;
    try {
      const data = new Uint8Array(await readFile(this.photoPath(meta.tokenHash, "img")));
      return { record: meta.record, data };
    } catch {
      return null;
    }
  }

  async setWallConsent(token: string, consent: boolean): Promise<PhotoRecord | null> {
    const meta = await this.meta(token);
    if (!meta) return null;
    // Only "none" ⇄ "PENDING" here. Moderation decisions belong to the admin surface.
    if (meta.record.wall !== "none" && meta.record.wall !== "PENDING") return meta.record;
    const record: PhotoRecord = { ...meta.record, wall: consent ? "PENDING" : "none" };
    await atomicWrite(this.photoPath(meta.tokenHash, "json"), JSON.stringify({ ...meta, record }));
    return record;
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function atomicWrite(file: string, data: string | Uint8Array) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}
