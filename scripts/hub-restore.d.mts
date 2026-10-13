// Types for scripts/hub-restore.mjs (plain Node so it runs without a build; tested from TypeScript).
export function findBackup(dir: string): Promise<string | null>;
export function restoreBackup(opts: {
  backupDir: string;
  dataDir: string;
  now?: Date;
}): Promise<{ photos: number; backedUpAt: string | null; movedAside: string | null }>;
