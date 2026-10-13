// Types for scripts/hub-start.mjs (plain Node so it runs without a build; tested from TypeScript).
export function restartDelay(failures: number): number;
export function lanAddresses(
  interfaces?: Record<string, { family: string; address: string; internal: boolean }[] | undefined>,
): string[];
export function browserCandidates(
  platform?: NodeJS.Platform,
  env?: Record<string, string | undefined>,
): string[];
export function kioskArgs(url: string, profileDir: string): string[];
export function readEnvFile(file: string): Record<string, string>;
