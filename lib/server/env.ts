import "server-only";
import { MIN_ADMIN_PASSWORD_LENGTH } from "@/lib/staff-auth/shared";

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
  /** How staff sign in (the fallback when sharedAdmin is on). Null = no staff login configured. */
  staffAuth: StaffAuthConfig | null;
  /**
   * Shared-password /admin login (D84): the password is the kiosk enrollment password
   * (kioskAuth.enrollSecret). Null = off: no enrollment password, or it is too short
   * (`sharedAdminProblem` says which, for the login page).
   */
  sharedAdmin: { sessionHours: number } | null;
  sharedAdminProblem: "no_password" | "password_too_short" | "auth_disabled" | null;
  /** Build identifier reported by kiosk heartbeats. */
  appBuild: string;
  localDataDir: string;
  linkTtlHours: number;
  retentionDays: number;
  kioskAuth:
    | {
        mode: "required";
        sessionSecret: string;
        /** Operator-chosen kiosk enrollment password. Null = one-time-code enrollment only. */
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
  hubRetention: { unpostedHours: number; wallUntil: Date | null; eventEnd: Date | null } | null;
  /**
   * Hub only: USB backup and disk warning (lib/ops/backup.ts). backupDir null = no backup
   * configured (the overview says so).
   */
  hubOps: { backupDir: string | null; backupMinutes: number; diskWarnBytes: number } | null;
  /**
   * AI review provider (D95). Null = none: every photo waits for a person, and nothing is sent
   * anywhere. A mistake in these settings never stops the booth: it turns the AI off and
   * `aiModerationProblem` says why (shown on /admin).
   */
  aiModeration: AiModerationConfig | null;
  aiModerationProblem: string | null;
  /**
   * Fallback AI provider (D98), or null. Like the primary, a mistake here is never a ConfigError:
   * it turns only the fallback off and `aiModerationFallbackProblem` says why (shown on /admin).
   */
  aiModerationFallback: AiModerationFallbackConfig | null;
  aiModerationFallbackProblem: string | null;
}

/** Which adapter, and what it needs. Shared by the primary and the fallback provider. */
export type AiProviderSettings =
  | {
      /** An OpenAI-style chat/completions endpoint with a vision model. */
      kind: "chat";
      /** Stored with each review: "cloudflare", or "openai-compatible". */
      id: string;
      baseUrl: URL;
      /** Null = send no Authorization header (a fallback such as Ollama that takes none). */
      apiKey: string | null;
      model: string;
      /** Extra request headers (a fallback behind Cloudflare Access: its service token). */
      headers?: Record<string, string>;
    }
  | { kind: "gemini"; apiKey: string; model: string }
  | { kind: "mock"; behaviour: "safe" | "unsafe" | "unsure" | "fail" | "slow" };

export type AiModerationConfig = {
  /** Provider requests per day, counted locally; past it photos wait for a person. */
  dailyLimit: number;
  timeoutMs: number;
} & AiProviderSettings;

/**
 * The second provider (D98): used only while the primary cannot take a photo, because its daily
 * limit here is used up or it answered "rate limited / out of quota". It never draws on the
 * primary's daily budget. Anything it cannot answer still waits for a person.
 */
export type AiModerationFallbackConfig = {
  /** One shot may take this long (a laptop is slower than a data centre). */
  timeoutMs: number;
  /** Send a photo's shots one after another instead of all at once (a fanless laptop). */
  sequential: boolean;
} & Exclude<AiProviderSettings, { kind: "mock" }>;

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

  // /admin opens with the kiosk enrollment password (D84). There is deliberately no separate
  // ADMIN_PASSWORD: the user decided on one shared credential. A short password is refused for
  // /admin only (it still enrolls booths), so a weak value can never be the key to moderation.
  let sharedAdmin: ServerConfig["sharedAdmin"] = null;
  let sharedAdminProblem: ServerConfig["sharedAdminProblem"] = null;
  if (kioskAuth.mode !== "required") sharedAdminProblem = "auth_disabled";
  else if (!kioskAuth.enrollSecret) sharedAdminProblem = "no_password";
  else if (kioskAuth.enrollSecret.length < MIN_ADMIN_PASSWORD_LENGTH)
    sharedAdminProblem = "password_too_short";
  else sharedAdmin = { sessionHours: positiveNumber(env, "ADMIN_SESSION_HOURS", 12, problems) };
  if (sharedAdmin && sharedAdmin.sessionHours > 24 * 7)
    problems.push("ADMIN_SESSION_HOURS must be 168 (one week) or less");

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
    let eventEnd: Date | null = null;
    if (rawEnd) {
      const end = new Date(rawEnd);
      // An explicit offset: "2026-12-25T22:00:00+09:00". A bare time would depend on the laptop.
      if (!/(Z|[+-]\d\d:\d\d)$/.test(rawEnd) || Number.isNaN(end.getTime()))
        problems.push(
          `EVENT_END_AT must be a date and time with an offset, e.g. 2026-12-25T22:00:00+09:00 (got "${rawEnd}")`,
        );
      else {
        eventEnd = end;
        wallUntil = new Date(end.getTime() + graceHours * 3_600_000);
      }
    }
    if (unpostedHours > retentionDays * 24)
      problems.push("HUB_UNPOSTED_HOURS cannot be longer than PHOTO_RETENTION_DAYS");
    hubRetention = { unpostedHours, wallUntil, eventEnd };
  } else if (env.EVENT_END_AT?.trim()) {
    problems.push("EVENT_END_AT is for the hub (FTL_ROLE=hub) only");
  }

  let hubOps: ServerConfig["hubOps"] = null;
  if (role === "hub") {
    hubOps = {
      backupDir: env.HUB_BACKUP_DIR?.trim() || null,
      backupMinutes: positiveNumber(env, "HUB_BACKUP_MINUTES", 10, problems),
      diskWarnBytes: positiveNumber(env, "HUB_DISK_WARN_MB", 2048, problems) * 1024 * 1024,
    };
    // A timer longer than 2^31-1 ms (about 24.8 days) fires after 1 ms in Node: a typo here
    // would copy the whole photo folder in a tight loop. One day is plenty for "rarely".
    if (hubOps.backupMinutes > 1440)
      problems.push("HUB_BACKUP_MINUTES must be 1440 (one day) or less");
  } else if (env.HUB_BACKUP_DIR?.trim()) {
    problems.push("HUB_BACKUP_DIR is for the hub (FTL_ROLE=hub) only");
  }

  const ai = parseAiModeration(env, strict);
  const aiFallback = parseAiModerationFallback(env, strict, ai.config !== null);

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
    sharedAdmin,
    sharedAdminProblem,
    appBuild: (env.VERCEL_GIT_COMMIT_SHA || env.FTL_APP_BUILD || "dev").slice(0, 12),
    cronSecret,
    // Vercel functions accept at most 4.5 MB request bodies; a final four-cut JPEG is ~0.3–1.5 MB.
    maxUploadBytes: 4 * 1024 * 1024,
    cloudSync,
    hubSyncSecret: role === "cloud" ? syncSecret : null,
    hubRetention,
    hubOps,
    aiModeration: ai.config,
    aiModerationProblem: ai.problem,
    aiModerationFallback: aiFallback.config,
    aiModerationFallbackProblem: aiFallback.problem,
  };
}

/**
 * AI review settings (D95). Unlike the rest of this file a problem here is not a ConfigError:
 * photography, QR delivery and human review must keep working when the AI settings are wrong, so
 * a bad value switches the AI off and is reported, never thrown.
 *
 *   AI_MODERATION_PROVIDER   cloudflare | openai-compatible | gemini | mock   (unset = off)
 *   AI_MODERATION_API_KEY    server-only; never NEXT_PUBLIC_
 *   AI_MODERATION_MODEL      the provider's model id (required; gemini has a default)
 *   AI_MODERATION_ACCOUNT_ID cloudflare only: the account that owns the Workers AI token
 *   AI_MODERATION_BASE_URL   openai-compatible only: https root that has /chat/completions
 *   AI_MODERATION_DAILY_LIMIT, AI_MODERATION_TIMEOUT_MS
 *   AI_MODERATION_PAID_TIER_CONFIRMED=1   gemini only (see below)
 */
function parseAiModeration(
  env: Env,
  strict: boolean,
): { config: AiModerationConfig | null; problem: string | null } {
  const provider = env.AI_MODERATION_PROVIDER?.trim().toLowerCase();
  if (!provider) return { config: null, problem: null };
  const off = (problem: string) => ({ config: null, problem });

  const dailyLimit = wholeNumber(env, "AI_MODERATION_DAILY_LIMIT", 300, 1, 100_000);
  if (dailyLimit === null)
    return off("AI_MODERATION_DAILY_LIMIT must be a whole number from 1 to 100000");
  // Under Vercel's shortest function limit (10 s) with room for the database calls around it.
  const timeoutMs = wholeNumber(env, "AI_MODERATION_TIMEOUT_MS", 8000, 1000, 25_000);
  if (timeoutMs === null)
    return off("AI_MODERATION_TIMEOUT_MS must be a whole number from 1000 to 25000");

  if (!["cloudflare", "openai-compatible", "gemini", "mock"].includes(provider))
    return off(
      `AI_MODERATION_PROVIDER must be cloudflare, openai-compatible, gemini or mock (got "${provider.slice(0, 40)}")`,
    );
  const parsed = parseAiProvider(env, "AI_MODERATION", provider, strict, false);
  if ("problem" in parsed) return off(parsed.problem);
  return { config: { dailyLimit, timeoutMs, ...parsed.settings }, problem: null };
}

/**
 * The fallback provider (D98): the same settings under AI_MODERATION_FALLBACK_*, minus the mock
 * and the daily limit (it does not draw on the primary's budget), plus:
 *
 *   AI_MODERATION_FALLBACK_PROVIDER    openai-compatible | cloudflare | gemini   (unset = none)
 *   AI_MODERATION_FALLBACK_API_KEY     optional for openai-compatible (Ollama takes none)
 *   AI_MODERATION_FALLBACK_TIMEOUT_MS  one shot, 1000..25000, default 20000
 *   AI_MODERATION_FALLBACK_SEQUENTIAL  "1" = one shot at a time (a fanless laptop)
 *   AI_MODERATION_FALLBACK_ACCESS_CLIENT_ID / _SECRET   openai-compatible only, both or neither:
 *       a Cloudflare Access service token for an endpoint behind Cloudflare Access
 *
 * A fallback with no working primary is refused: it is a fallback, and the switch on /admin, the
 * queue and the daily accounting all belong to the primary.
 */
function parseAiModerationFallback(
  env: Env,
  strict: boolean,
  primaryOn: boolean,
): { config: AiModerationFallbackConfig | null; problem: string | null } {
  const provider = env.AI_MODERATION_FALLBACK_PROVIDER?.trim().toLowerCase();
  if (!provider) return { config: null, problem: null };
  const off = (problem: string) => ({ config: null, problem });
  if (!primaryOn)
    return off(
      "AI_MODERATION_FALLBACK_PROVIDER needs a working AI_MODERATION_PROVIDER (the fallback is only used when the primary cannot take a photo)",
    );
  if (!["openai-compatible", "cloudflare", "gemini"].includes(provider))
    return off(
      `AI_MODERATION_FALLBACK_PROVIDER must be openai-compatible, cloudflare or gemini (got "${provider.slice(0, 40)}")`,
    );
  const timeoutMs = wholeNumber(env, "AI_MODERATION_FALLBACK_TIMEOUT_MS", 20_000, 1000, 25_000);
  if (timeoutMs === null)
    return off("AI_MODERATION_FALLBACK_TIMEOUT_MS must be a whole number from 1000 to 25000");
  const rawSequential = env.AI_MODERATION_FALLBACK_SEQUENTIAL?.trim() ?? "";
  if (!["", "0", "1"].includes(rawSequential))
    return off("AI_MODERATION_FALLBACK_SEQUENTIAL must be 1 (one shot at a time) or empty");

  const parsed = parseAiProvider(
    env,
    "AI_MODERATION_FALLBACK",
    provider,
    strict,
    provider === "openai-compatible",
  );
  if ("problem" in parsed) return off(parsed.problem);
  const settings = parsed.settings;
  if (settings.kind === "mock") return off("AI_MODERATION_FALLBACK_PROVIDER cannot be mock");

  const accessId = env.AI_MODERATION_FALLBACK_ACCESS_CLIENT_ID?.trim() ?? "";
  const accessSecret = env.AI_MODERATION_FALLBACK_ACCESS_CLIENT_SECRET?.trim() ?? "";
  if (accessId || accessSecret) {
    if (settings.kind !== "chat" || settings.id !== "openai-compatible")
      return off("AI_MODERATION_FALLBACK_ACCESS_CLIENT_* is for openai-compatible only");
    if (!accessId || !accessSecret)
      return off(
        "AI_MODERATION_FALLBACK_ACCESS_CLIENT_ID and _SECRET must be set together (a Cloudflare Access service token)",
      );
    if (!/^[\w.-]{1,200}$/.test(accessId) || !/^[\w.-]{1,200}$/.test(accessSecret))
      return off(
        "AI_MODERATION_FALLBACK_ACCESS_CLIENT_* has characters a service token cannot have",
      );
    settings.headers = { "cf-access-client-id": accessId, "cf-access-client-secret": accessSecret };
  }
  return {
    config: { timeoutMs, sequential: rawSequential === "1", ...settings },
    problem: null,
  };
}

function wholeNumber(env: Env, key: string, fallback: number, min: number, max: number) {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * One provider's settings under `prefix` (AI_MODERATION or AI_MODERATION_FALLBACK). `provider` is
 * already one of the names the caller allows. The problem text names variables, never values.
 */
function parseAiProvider(
  env: Env,
  prefix: string,
  provider: string,
  strict: boolean,
  keyOptional: boolean,
): { settings: AiProviderSettings } | { problem: string } {
  const v = (name: string) => env[`${prefix}_${name}`]?.trim();
  if (provider === "mock") {
    // Approves without looking at anything: never on a real deployment.
    if (strict) return { problem: `${prefix}_PROVIDER=mock is for development and tests only` };
    const behaviour = v("MOCK") || "safe";
    if (!["safe", "unsafe", "unsure", "fail", "slow"].includes(behaviour))
      return { problem: `${prefix}_MOCK must be safe, unsafe, unsure, fail or slow` };
    return { settings: { kind: "mock", behaviour: behaviour as "safe" } };
  }

  const apiKey = v("API_KEY") || null;
  if (!apiKey && !keyOptional) return { problem: `${prefix}_API_KEY is missing` };
  const model = v("MODEL");
  if (model && !/^[\w@./:-]{1,120}$/.test(model))
    return { problem: `${prefix}_MODEL has characters a model id cannot have` };

  if (provider === "gemini") {
    // Google's unpaid tier may use submitted content to improve its products, with human
    // reviewers: not acceptable for guests' photos. The API cannot tell us which tier a key is
    // on, so the operator has to say so, in writing, here.
    if (env[`${prefix}_PAID_TIER_CONFIRMED`] !== "1")
      return {
        problem: `Gemini is allowed on the paid tier only: enable billing for the key's project, then set ${prefix}_PAID_TIER_CONFIRMED=1`,
      };
    return {
      settings: { kind: "gemini", apiKey: apiKey!, model: model || "gemini-3.5-flash-lite" },
    };
  }

  // cloudflare, or any other OpenAI-style chat/completions endpoint.
  if (!model) return { problem: `${prefix}_MODEL is required (the provider's vision model id)` };
  let rawBase: string;
  if (provider === "cloudflare") {
    const account = v("ACCOUNT_ID");
    if (!account || !/^[0-9a-f]{32}$/i.test(account))
      return { problem: `${prefix}_ACCOUNT_ID must be the 32-character Cloudflare account id` };
    rawBase = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`;
  } else {
    rawBase = v("BASE_URL") ?? "";
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBase);
  } catch {
    return { problem: `${prefix}_BASE_URL is not a valid URL` };
  }
  // Photos travel in the request: never over plain HTTP, never to a private address by typo.
  if (baseUrl.protocol !== "https:" || baseUrl.search || baseUrl.hash || baseUrl.username)
    return { problem: `${prefix}_BASE_URL must be a plain https URL` };
  if (strict && isPrivateHost(baseUrl.hostname))
    return { problem: `${prefix}_BASE_URL points at a private/local host` };
  return { settings: { kind: "chat", id: provider, baseUrl, apiKey, model } };
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
