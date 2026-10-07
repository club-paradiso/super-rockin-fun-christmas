import "server-only";

/**
 * All server configuration in one place, validated once. Secrets live only in server-side env
 * vars (no NEXT_PUBLIC_ prefix), so they can never reach the browser bundle.
 */

export type StoreBackend = "supabase" | "local";

export interface ServerConfig {
  /** Strict = real deployment. Enforces https public origin and strong secrets. */
  strict: boolean;
  publicBaseUrl: URL | null;
  store: StoreBackend;
  supabase: { url: string; serviceRoleKey: string; bucket: string } | null;
  localDataDir: string;
  linkTtlHours: number;
  retentionDays: number;
  kioskAuth:
    | { mode: "required"; sessionSecret: string; enrollSecret: string; sessionDays: number }
    | { mode: "disabled" };
  cronSecret: string | null;
  maxUploadBytes: number;
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

  let publicBaseUrl: URL | null = null;
  const rawBase = env.PUBLIC_BASE_URL?.trim();
  if (rawBase) {
    try {
      publicBaseUrl = new URL(rawBase);
      if (publicBaseUrl.pathname !== "/" || publicBaseUrl.search || publicBaseUrl.hash) {
        problems.push("PUBLIC_BASE_URL must be an origin only, e.g. https://lights.example.org");
      }
      if (strict && publicBaseUrl.protocol !== "https:") {
        problems.push("PUBLIC_BASE_URL must use https in production");
      }
      if (strict && isPrivateHost(publicBaseUrl.hostname)) {
        problems.push(
          `PUBLIC_BASE_URL points at a private/local host (${publicBaseUrl.hostname}); phones on cellular data cannot reach it`,
        );
      }
    } catch {
      problems.push(`PUBLIC_BASE_URL is not a valid URL ("${rawBase}")`);
    }
  } else if (strict) {
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
    const enrollSecret = env.KIOSK_ENROLL_SECRET ?? "";
    if (sessionSecret.length < 32) {
      problems.push(
        "KIOSK_SESSION_SECRET must be at least 32 characters (openssl rand -base64 48)",
      );
    }
    if (enrollSecret.length < 20) {
      problems.push("KIOSK_ENROLL_SECRET must be at least 20 characters");
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

  const cronSecret = env.CRON_SECRET?.trim() || null;
  if (cronSecret && cronSecret.length < 32)
    problems.push("CRON_SECRET must be at least 32 characters");
  if (strict && !cronSecret)
    problems.push("CRON_SECRET is required in production (retention cleanup)");

  if (problems.length) throw new ConfigError(problems);

  return {
    strict,
    publicBaseUrl,
    store,
    supabase,
    localDataDir: env.FTL_DATA_DIR?.trim() || ".data",
    linkTtlHours,
    retentionDays,
    kioskAuth,
    cronSecret,
    // Vercel functions accept at most 4.5 MB request bodies; a final four-cut JPEG is ~0.3–1.5 MB.
    maxUploadBytes: 4 * 1024 * 1024,
  };
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
