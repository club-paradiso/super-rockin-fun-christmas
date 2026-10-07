import "server-only";
import path from "node:path";
import { LocalPhotoStore } from "./local-store";
import type { PhotoStore } from "./types";

let store: PhotoStore | null = null;

export function linkTtlHours(): number {
  const n = Number(process.env.PHOTO_LINK_TTL_HOURS ?? 72);
  return Number.isFinite(n) && n > 0 ? n : 72;
}

/** The configured PhotoStore. Phase 2 switches to Supabase when its env vars are present. */
export function getPhotoStore(): PhotoStore {
  store ??= new LocalPhotoStore({
    // The hint stops Turbopack from tracing the whole project into the server bundle.
    rootDir: path.resolve(
      /* turbopackIgnore: true */ process.cwd(),
      process.env.FTL_DATA_DIR ?? ".data",
    ),
    linkTtlHours: linkTtlHours(),
  });
  return store;
}

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
