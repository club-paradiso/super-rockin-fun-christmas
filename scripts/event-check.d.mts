// Types for scripts/event-check.mjs (plain Node so it runs without a build; tested from TypeScript).
export interface FolderSize {
  files: number;
  bytes: number;
}
export interface DatabaseLeft {
  live: number;
  cloudNotDeleted: number;
}
export interface EventCheckResult {
  database: DatabaseLeft | null;
  photoFiles: FolderSize;
  restoreAsides: { folders: string[] } & FolderSize;
  backup: { folder: string; database: DatabaseLeft | null; photoFiles: FolderSize } | null;
  browserProfile: FolderSize;
}
export function folderSize(dir: string): Promise<FolderSize>;
export function databaseLeft(dbFile: string): Promise<DatabaseLeft | null>;
export function eventCheck(opts: {
  dataDir: string;
  backupDir: string | null;
  browserDir: string;
}): Promise<EventCheckResult>;
export function isClean(r: EventCheckResult): boolean;
