import "server-only";

/**
 * All server configuration in one place, validated once. Secrets live only in server-side env
 * vars (no NEXT_PUBLIC_ prefix), so they can never reach the browser bundle.
 */

export type StoreBackend = "supabase" | "local";

/**
 * `cloud` = the Vercel + Supabase deployment (Phase 1–4 behaviour). `hub` = the on-site hub on
 * the venue LAN (docs/ARCHITECTURE.md part 1): local files are the source of truth, staff sign in
 * with a PIN, and the wall and staff phones reach it over plain HTTP on a dedicated router.
 */
export type ServerRole = "cloud" | "hub";

export type StaffAuthConfig =
  /** Supabase Auth email codes + allowlist (cloud). */
  | { mode: "supabase"; url: string; anonKey: string }
  /** Name + PIN against the hub's own staff list (hub). Works without internet. */
  | { mode: "pin"; sessionHours: number };

export interface ServerConfig {
  role: ServerRole;
  /** Strict = real deployment. Enforces https public origin and strong secrets. */
  strict: boolean;
  publicBaseUrl: URL | null;
  store: StoreBackend;
  supabase: { url: string; serviceRoleKey: string; bucket: string } | null;
  /** How staff sign in. Null = /admin unavailable. */
  staffAuth: StaffAuthConfig | null;
  /** Build identifier reported by kiosk heartbeats. */
  appBuild: string;
  localDataDir: string;
  linkTtlHours: number;
  retentionDays: number;
  kioskAuth:
    | {
        mode: "required";
        sessionSecret: string;
        /** Phase 2 shared secret (legacy). Null = only one-time staff codes can enroll kiosks. */
        enrollSecret: string | null;
        sessionDays: number;
      }
    | { mode: "disabled" };
  cronSecret: string | null;
  maxUploadBytes: number;
  /**
   * Hub only: where the QR copy goes (docs/ARCHITECTURE.md 1.5). Null = no cloud configured; the
   * hub then works fully offline and its QR codes point at the hub itself (LAN only).
   */
  cloudSync: { baseUrl: URL; secret: string; timeoutMs: number } | null;
  /** Cloud only: the shared secret that lets the hub use /api/hub/*. Null = those routes 404. */
  hubSyncSecret: string | null;
  /**
   * Hub only (D47): photos that never reach the wall go `unpostedHours` after capture; wall
   * photos (approved or hidden) at `wallUntil` (EVENT_END_AT + HUB_WALL_GRACE_HOURS). Null
   * wallUntil = no event end configured: the PHOTO_RETENTION_DAYS ceiling decides. That ceiling
   * applies to every photo in any case.
   */
  hubRetention: { unpostedHours: number; wallUntil: Date | null } | null;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid server configuration:\n - ${problems.join("\n - ")}`);
    this.name = "ConfigError";
  }
}

/** Hostnames that must never appear in a production QR code. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h.includes(":")) {
    return h === "::1" || h === "::" || h.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(h);
  }
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

type Env = Record<string, string | undefined>;

function secretsCollide(secret: string, env: Env): boolean {
  return [env.KIOSK_SESSION_SECRET, env.KIOSK_ENROLL_SECRET, env.CRON_SECRET].some(
    (other) => !!other && other.trim() === secret,
  );
}

function positiveNumber(env: Env, key: string, fallback: number, problems: string[]): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    problems.push(`${key} must be a positive number (got "${raw}")`);
    return fallback;
  }
  return n;
}

export function parseServerConfig(env: Env): ServerConfig {
  const problems: string[] = [];
  const onVercel = !!env.VERCEL_ENV;
  // FTL_ALLOW_LOCAL_ORIGIN lets the E2E suite run a production build on 127.0.0.1. It is
  // ignored on Vercel so a stray flag can never weaken a real deployment.
  const strict = env.NODE_ENV === "production" && (onVercel || env.FTL_ALLOW_LOCAL_ORIGIN !== "1");

  const rawRole = env.FTL_ROLE?.trim() || "cloud";
  if (rawRole !== "cloud" && rawRole !== "hub") {
    problems.push(`FTL_ROLE must be "cloud" or "hub" (got "${rawRole}")`);
  }
  const role: ServerRole = rawRole === "hub" ? "hub" : "cloud";
  if (role === "hub" && onVercel)
    problems.push("FTL_ROLE=hub runs on the venue laptop, not Vercel");
  // The hub serves the venue LAN over plain HTTP; its QR links come from the cloud copy
  // (docs/ARCHITECTURE.md 1.5), so the public-origin rules below apply to the cloud only.
  const publicRules = strict && role === "cloud";

  let publicBaseUrl: URL | null = null;
  const rawBase = env.PUBLIC_BASE_URL?.trim();
  if (rawBase) {
    try {
      publicBaseUrl = new URL(rawBase);
      if (publicBaseUrl.pathname !== "/" || publicBaseUrl.search || publicBaseUrl.hash) {
        problems.push("PUBLIC_BASE_URL must be an origin only, e.g. https://lights.example.org");
      }
      if (publicRules && publicBaseUrl.protocol !== "https:") {
        problems.push("PUBLIC_BASE_URL must use https in production");
      }
      if (publicRules && isPrivateHost(publicBaseUrl.hostname)) {
        problems.push(
          `PUBLIC_BASE_URL points at a private/local host (${publicBaseUrl.hostname}); phones on cellular data cannot reach it`,
        );
      }
    } catch {
      problems.push(`PUBLIC_BASE_URL is not a valid URL ("${rawBase}")`);
    }
  } else if (publicRules) {
    problems.push("PUBLIC_BASE_URL is required in production (QR codes are built from it)");
  }

  const supabaseUrl = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const requested = env.PHOTO_STORE?.trim();
  const store: StoreBackend =
    requested === "local" || requested === "supabase"
      ? requested
      : supabaseUrl
        ? "supabase"
        : "local";
  if (requested && requested !== "local" && requested !== "supabase") {
    problems.push(`PHOTO_STORE must be "supabase" or "local" (got "${requested}")`);
  }
  if (role === "hub" && store !== "local") {
    problems.push("FTL_ROLE=hub keeps everything on the laptop: set PHOTO_STORE=local");
  }
  let supabase: ServerConfig["supabase"] = null;
  if (store === "supabase") {
    if (!supabaseUrl || !serviceRoleKey) {
      problems.push("PHOTO_STORE=supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    } else {
      supabase = {
        url: supabaseUrl,
        serviceRoleKey,
        bucket: env.SUPABASE_PHOTO_BUCKET?.trim() || "photos",
      };
    }
  } else if (onVercel) {
    problems.push(
      "Vercel's filesystem is ephemeral: set PHOTO_STORE=supabase with Supabase credentials",
    );
  }

  const linkTtlHours = positiveNumber(env, "PHOTO_LINK_TTL_HOURS", 72, problems);
  const retentionDays = positiveNumber(env, "PHOTO_RETENTION_DAYS", 30, problems);
  if (retentionDays * 24 < linkTtlHours) {
    problems.push("PHOTO_RETENTION_DAYS must cover at least PHOTO_LINK_TTL_HOURS");
  }

  let kioskAuth: ServerConfig["kioskAuth"];
  if (env.KIOSK_AUTH_DISABLED === "1") {
    if (env.NODE_ENV === "production") {
      problems.push("KIOSK_AUTH_DISABLED=1 is only allowed in development");
    }
    kioskAuth = { mode: "disabled" };
  } else {
    const sessionSecret = env.KIOSK_SESSION_SECRET ?? "";
    const enrollSecret = env.KIOSK_ENROLL_SECRET?.trim() || null;
    if (sessionSecret.length < 32) {
      problems.push(
        "KIOSK_SESSION_SECRET must be at least 32 characters (openssl rand -base64 48)",
      );
    }
    if (enrollSecret !== null && enrollSecret.length < 20) {
      problems.push("KIOSK_ENROLL_SECRET must be at least 20 characters (or unset it)");
    }
    if (sessionSecret && sessionSecret === enrollSecret) {
      problems.push("KIOSK_SESSION_SECRET and KIOSK_ENROLL_SECRET must differ");
    }
    kioskAuth = {
      mode: "required",
      sessionSecret,
      enrollSecret,
      sessionDays: positiveNumber(env, "KIOSK_SESSION_DAYS", 90, problems),
    };
  }

  // Staff login uses Supabase Auth with the anon/publishable key — server-side only (no
  // NEXT_PUBLIC_): the browser never talks to Supabase. Being a Supabase user grants nothing;
  // authorization is the staff_members allowlist.
  const anonKey = env.SUPABASE_ANON_KEY?.trim();
  let staffAuth: ServerConfig["staffAuth"] = null;
  if (role === "hub") {
    staffAuth = {
      mode: "pin",
      sessionHours: positiveNumber(env, "STAFF_SESSION_HOURS", 14, problems),
    };
  } else if (store === "supabase" && supabase && anonKey) {
    staffAuth = { mode: "supabase", url: supabase.url, anonKey };
  } else if (strict && store === "supabase") {
    problems.push("SUPABASE_ANON_KEY is required for staff login (/admin) in production");
  }

  const cronSecret = env.CRON_SECRET?.trim() || null;
  if (cronSecret && cronSecret.length < 32)
    problems.push("CRON_SECRET must be at least 32 characters");
  // The hub runs its own retention in-process; only the cloud is called by Vercel Cron.
  if (publicRules && !cronSecret)
    problems.push("CRON_SECRET is required in production (retention cleanup)");

  // Hub ⇄ cloud copy for QR downloads (D43). One shared secret, set on both sides.
  const syncSecret = env.HUB_SYNC_SECRET?.trim() || null;
  if (syncSecret && syncSecret.length < 32)
    problems.push("HUB_SYNC_SECRET must be at least 32 characters (openssl rand -base64 48)");
  if (syncSecret && secretsCollide(syncSecret, env))
    problems.push("HUB_SYNC_SECRET must differ from the kiosk and cron secrets");
  let cloudSync: ServerConfig["cloudSync"] = null;
  const rawCloud = env.CLOUD_BASE_URL?.trim();
  if (rawCloud) {
    if (role !== "hub") problems.push("CLOUD_BASE_URL is for the hub (FTL_ROLE=hub) only");
    let baseUrl: URL | null = null;
    try {
      baseUrl = new URL(rawCloud);
      if (baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash)
        problems.push("CLOUD_BASE_URL must be an origin only, e.g. https://lights.example.org");
      if (strict && baseUrl.protocol !== "https:")
        problems.push("CLOUD_BASE_URL must use https (photos travel over the internet)");
    } catch {
      problems.push(`CLOUD_BASE_URL is not a valid URL ("${rawCloud}")`);
    }
    if (!syncSecret)
      problems.push("CLOUD_BASE_URL needs HUB_SYNC_SECRET (the same value as the cloud)");
    if (baseUrl && syncSecret)
      cloudSync = {
        baseUrl,
        secret: syncSecret,
        timeoutMs: positiveNumber(env, "CLOUD_SYNC_TIMEOUT_MS", 8000, problems),
      };
  }

  let hubRetention: ServerConfig["hubRetention"] = null;
  if (role === "hub") {
    const unpostedHours = positiveNumber(env, "HUB_UNPOSTED_HOURS", 24, problems);
    const graceHours = positiveNumber(env, "HUB_WALL_GRACE_HOURS", 24, problems);
    const rawEnd = env.EVENT_END_AT?.trim();
    let wallUntil: Date | null = null;
    if (rawEnd) {
      const end = new Date(rawEnd);
      // An explicit offset: "2026-12-25T22:00:00+09:00". A bare time would depend on the laptop.
      if (!/(Z|[+-]\d\d:\d\d)$/.test(rawEnd) || Number.isNaN(end.getTime()))
        problems.push(
          `EVENT_END_AT must be a date and time with an offset, e.g. 2026-12-25T22:00:00+09:00 (got "${rawEnd}")`,
        );
      else wallUntil = new Date(end.getTime() + graceHours * 3_600_000);
    }
    if (unpostedHours > retentionDays * 24)
      problems.push("HUB_UNPOSTED_HOURS cannot be longer than PHOTO_RETENTION_DAYS");
    hubRetention = { unpostedHours, wallUntil };
  } else if (env.EVENT_END_AT?.trim()) {
    problems.push("EVENT_END_AT is for the hub (FTL_ROLE=hub) only");
  }

  if (problems.length) throw new ConfigError(problems);

  return {
    role,
    strict,
    publicBaseUrl,
    store,
    supabase,
    localDataDir: env.FTL_DATA_DIR?.trim() || ".data",
    linkTtlHours,
    retentionDays,
    kioskAuth,
    staffAuth,
    appBuild: (env.VERCEL_GIT_COMMIT_SHA || env.FTL_APP_BUILD || "dev").slice(0, 12),
    cronSecret,
    // Vercel functions accept at most 4.5 MB request bodies; a final four-cut JPEG is ~0.3–1.5 MB.
    maxUploadBytes: 4 * 1024 * 1024,
    cloudSync,
    hubSyncSecret: role === "cloud" ? syncSecret : null,
    hubRetention,
  };
}

/**
 * Whether session cookies get the `Secure` flag. The hub serves the venue LAN over plain HTTP,
 * where browsers drop Secure cookies, so it relies on https only when the request actually used
 * it (the LAN is a dedicated, password-protected router: docs/DECISIONS.md D42).
 */
export function secureCookies(config: ServerConfig, request: Request): boolean {
  const https = new URL(request.url).protocol === "https:";
  return config.role === "hub" ? https : config.strict || https;
}

let cached: { config: ServerConfig } | { error: ConfigError } | null = null;

/** Throws ConfigError on invalid configuration — loudly, on every request that needs it. */
export function getServerConfig(): ServerConfig {
  cached ??= (() => {
    try {
      return { config: parseServerConfig(process.env) };
    } catch (err) {
      if (err instanceof ConfigError) return { error: err };
      throw err;
    }
  })();
  if ("error" in cached) throw cached.error;
  return cached.config;
}

/** For tests only. */
export function resetServerConfigForTests() {
  cached = null;
}
