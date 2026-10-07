import "server-only";
import path from "node:path";
import { getServerConfig } from "@/lib/server/env";
import { createLocalBackend } from "./local-backend";
import { PhotoService } from "./photo-service";
import { createSupabaseBackend } from "./supabase-backend";
import type { StorageBackend } from "./types";

let backend: StorageBackend | null = null;
let service: PhotoService | null = null;

/** The configured backend (Supabase in deployment, local files otherwise). */
export function getBackend(): StorageBackend {
  if (backend) return backend;
  const config = getServerConfig();
  backend =
    config.store === "supabase" && config.supabase
      ? createSupabaseBackend(config.supabase)
      : createLocalBackend(
          // The hint stops Turbopack from tracing the whole project into the server bundle.
          path.resolve(/* turbopackIgnore: true */ process.cwd(), config.localDataDir),
        );
  return backend;
}

export function getPhotoService(): PhotoService {
  if (service) return service;
  const config = getServerConfig();
  service = new PhotoService(getBackend(), {
    linkTtlHours: config.linkTtlHours,
    retentionDays: config.retentionDays,
  });
  return service;
}

/** For tests only. */
export function resetStorageForTests() {
  backend = null;
  service = null;
}
