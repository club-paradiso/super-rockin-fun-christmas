// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ConfigError, isPrivateHost, parseServerConfig, secureCookies } from "@/lib/server/env";

const SECRETS = {
  KIOSK_SESSION_SECRET: "s".repeat(48),
  KIOSK_ENROLL_SECRET: "e".repeat(24),
  CRON_SECRET: "c".repeat(40),
};
const PROD = {
  NODE_ENV: "production",
  ...SECRETS,
  PUBLIC_BASE_URL: "https://lights.example.org",
  SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  SUPABASE_ANON_KEY: "anon",
};

const problems = (env: Record<string, string | undefined>) => {
  try {
    parseServerConfig(env);
    return [];
  } catch (e) {
    return (e as ConfigError).problems;
  }
};

describe("server config", () => {
  it("accepts a valid production config", () => {
    const c = parseServerConfig(PROD);
    expect(c.strict).toBe(true);
    expect(c.store).toBe("supabase");
    expect(c.publicBaseUrl!.origin).toBe("https://lights.example.org");
  });

  it.each([
    ["http://lights.example.org", /https/],
    ["https://localhost:3000", /private\/local/],
    ["https://127.0.0.1", /private\/local/],
    ["https://192.168.0.20", /private\/local/],
    ["https://10.1.2.3", /private\/local/],
    ["https://kiosk.local", /private\/local/],
    ["https://lights.example.org/p", /origin only/],
    ["not a url", /not a valid URL/],
  ])("rejects PUBLIC_BASE_URL %s in production", (url, re) => {
    expect(problems({ ...PROD, PUBLIC_BASE_URL: url }).join()).toMatch(re);
  });

  it("requires PUBLIC_BASE_URL and CRON_SECRET in production", () => {
    expect(problems({ ...PROD, PUBLIC_BASE_URL: undefined }).join()).toMatch(
      /PUBLIC_BASE_URL is required/,
    );
    expect(problems({ ...PROD, CRON_SECRET: undefined }).join()).toMatch(/CRON_SECRET/);
  });

  it("requires strong, distinct kiosk secrets", () => {
    expect(problems({ ...PROD, KIOSK_SESSION_SECRET: "short" }).join()).toMatch(
      /KIOSK_SESSION_SECRET/,
    );
    const same = "x".repeat(40);
    expect(
      problems({ ...PROD, KIOSK_SESSION_SECRET: same, KIOSK_ENROLL_SECRET: same }).join(),
    ).toMatch(/differ/);
  });

  it("allows an operator-chosen kiosk password without a minimum length", () => {
    const config = parseServerConfig({ ...PROD, KIOSK_ENROLL_SECRET: "1234" });
    expect(config.kioskAuth).toMatchObject({ mode: "required", enrollSecret: "1234" });
    expect(problems({ ...PROD, KIOSK_ENROLL_SECRET: "1234" })).toEqual([]);
    expect(parseServerConfig({ ...PROD, KIOSK_ENROLL_SECRET: " " }).kioskAuth).toMatchObject({
      mode: "required",
      enrollSecret: null,
    });
  });

  it("never allows disabling kiosk auth in production", () => {
    expect(problems({ ...PROD, KIOSK_AUTH_DISABLED: "1" }).join()).toMatch(
      /only allowed in development/,
    );
    expect(
      parseServerConfig({ NODE_ENV: "development", KIOSK_AUTH_DISABLED: "1" }).kioskAuth.mode,
    ).toBe("disabled");
  });

  it("ignores the local-origin escape hatch on Vercel", () => {
    const env = { ...PROD, FTL_ALLOW_LOCAL_ORIGIN: "1", PUBLIC_BASE_URL: "http://127.0.0.1:3000" };
    expect(problems(env)).toEqual([]); // self-hosted test run
    expect(problems({ ...env, VERCEL_ENV: "preview" }).length).toBeGreaterThan(0);
  });

  it("refuses the local store on Vercel and Supabase without keys", () => {
    expect(problems({ ...PROD, VERCEL_ENV: "production", SUPABASE_URL: undefined }).join()).toMatch(
      /ephemeral/,
    );
    expect(problems({ ...PROD, SUPABASE_SERVICE_ROLE_KEY: undefined }).join()).toMatch(
      /SERVICE_ROLE/,
    );
  });

  it("requires retention to outlive the link", () => {
    expect(
      problems({ ...PROD, PHOTO_LINK_TTL_HOURS: "240", PHOTO_RETENTION_DAYS: "2" }).join(),
    ).toMatch(/RETENTION/);
  });

  it("development works with no public URL (falls back to request origin)", () => {
    const c = parseServerConfig({ NODE_ENV: "development", ...SECRETS });
    expect([c.strict, c.publicBaseUrl, c.store]).toEqual([false, null, "local"]);
  });
});

describe("hub role (FTL_ROLE=hub)", () => {
  const HUB = {
    NODE_ENV: "production",
    FTL_ROLE: "hub",
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: SECRETS.KIOSK_SESSION_SECRET,
  };

  it("runs a production build on the LAN without a public URL or cron secret", () => {
    const c = parseServerConfig(HUB);
    expect([c.role, c.strict, c.store, c.publicBaseUrl]).toEqual(["hub", true, "local", null]);
    expect(c.staffAuth).toEqual({ mode: "pin", sessionHours: 14 });
    expect(c.cronSecret).toBeNull();
  });

  it("allows a LAN http PUBLIC_BASE_URL on the hub only", () => {
    expect(problems({ ...HUB, PUBLIC_BASE_URL: "http://192.168.0.10:3000" })).toEqual([]);
    expect(problems({ ...PROD, PUBLIC_BASE_URL: "http://192.168.0.10:3000" }).length).toBe(2);
  });

  it("still requires strong kiosk secrets and kiosk auth", () => {
    expect(problems({ ...HUB, KIOSK_SESSION_SECRET: "short" }).join()).toMatch(
      /KIOSK_SESSION_SECRET/,
    );
    expect(problems({ ...HUB, KIOSK_AUTH_DISABLED: "1" }).join()).toMatch(/development/);
  });

  it("keeps everything local and never runs on Vercel", () => {
    expect(problems({ ...HUB, PHOTO_STORE: "supabase", ...PROD, FTL_ROLE: "hub" }).join()).toMatch(
      /PHOTO_STORE=local/,
    );
    expect(problems({ ...HUB, VERCEL_ENV: "production" }).join()).toMatch(/not Vercel/);
  });

  it("rejects an unknown role; the default stays cloud with Supabase staff login", () => {
    expect(problems({ ...HUB, FTL_ROLE: "edge" }).join()).toMatch(/FTL_ROLE/);
    const c = parseServerConfig(PROD);
    expect(c.role).toBe("cloud");
    expect(c.staffAuth?.mode).toBe("supabase");
  });

  it("STAFF_SESSION_HOURS is configurable", () => {
    expect(parseServerConfig({ ...HUB, STAFF_SESSION_HOURS: "8" }).staffAuth).toEqual({
      mode: "pin",
      sessionHours: 8,
    });
  });

  it("Secure cookies: the hub follows the request; the strict cloud always", () => {
    const http = new Request("http://192.168.0.10:3000/admin");
    const https = new Request("https://lights.example.org/admin");
    const hub = parseServerConfig(HUB);
    const cloud = parseServerConfig(PROD);
    expect([secureCookies(hub, http), secureCookies(hub, https)]).toEqual([false, true]);
    expect([secureCookies(cloud, http), secureCookies(cloud, https)]).toEqual([true, true]);
  });
});

describe("hub → cloud copy config", () => {
  const HUB = {
    NODE_ENV: "production",
    FTL_ROLE: "hub",
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: SECRETS.KIOSK_SESSION_SECRET,
  };
  const SYNC = "y".repeat(40);

  it("hub: CLOUD_BASE_URL + HUB_SYNC_SECRET enable the copy; https required for real", () => {
    const c = parseServerConfig({
      ...HUB,
      CLOUD_BASE_URL: "https://lights.example.org",
      HUB_SYNC_SECRET: SYNC,
    });
    expect(c.cloudSync).toMatchObject({ secret: SYNC, timeoutMs: 8000 });
    expect(c.cloudSync!.baseUrl.origin).toBe("https://lights.example.org");
    expect(c.hubSyncSecret).toBeNull(); // the hub never serves /api/hub
    expect(
      problems({
        ...HUB,
        CLOUD_BASE_URL: "http://lights.example.org",
        HUB_SYNC_SECRET: SYNC,
      }).join(),
    ).toMatch(/https/);
    expect(problems({ ...HUB, CLOUD_BASE_URL: "https://lights.example.org" }).join()).toMatch(
      /HUB_SYNC_SECRET/,
    );
  });

  it("no cloud configured: the hub runs offline-only", () => {
    expect(parseServerConfig(HUB).cloudSync).toBeNull();
  });

  it("cloud: HUB_SYNC_SECRET opens /api/hub; strong and distinct; CLOUD_BASE_URL is hub-only", () => {
    expect(parseServerConfig({ ...PROD, HUB_SYNC_SECRET: SYNC }).hubSyncSecret).toBe(SYNC);
    expect(parseServerConfig(PROD).hubSyncSecret).toBeNull();
    expect(problems({ ...PROD, HUB_SYNC_SECRET: "short" }).join()).toMatch(/32 characters/);
    expect(problems({ ...PROD, HUB_SYNC_SECRET: SECRETS.KIOSK_SESSION_SECRET }).join()).toMatch(
      /differ/,
    );
    expect(
      problems({ ...PROD, CLOUD_BASE_URL: "https://x.example.org", HUB_SYNC_SECRET: SYNC }).join(),
    ).toMatch(/hub \(FTL_ROLE=hub\) only/);
  });
});

describe("hub retention config (D47)", () => {
  const HUB = {
    NODE_ENV: "production",
    FTL_ROLE: "hub",
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: SECRETS.KIOSK_SESSION_SECRET,
  };

  it("defaults: unposted 24 h, no event end (the PHOTO_RETENTION_DAYS ceiling decides)", () => {
    expect(parseServerConfig(HUB).hubRetention).toEqual({
      unpostedHours: 24,
      wallUntil: null,
      eventEnd: null,
    });
    expect(parseServerConfig(PROD).hubRetention).toBeNull();
  });

  it("wall photos go at EVENT_END_AT + HUB_WALL_GRACE_HOURS", () => {
    const c = parseServerConfig({ ...HUB, EVENT_END_AT: "2026-12-25T22:00:00+09:00" });
    expect(c.hubRetention?.wallUntil?.toISOString()).toBe("2026-12-26T13:00:00.000Z");
    const short = parseServerConfig({
      ...HUB,
      EVENT_END_AT: "2026-12-25T13:00:00Z",
      HUB_WALL_GRACE_HOURS: "2",
      HUB_UNPOSTED_HOURS: "6",
    });
    expect(short.hubRetention).toEqual({
      unpostedHours: 6,
      wallUntil: new Date("2026-12-25T15:00:00Z"),
      eventEnd: new Date("2026-12-25T13:00:00Z"),
    });
  });

  it("refuses an event end without an offset, nonsense, and settings that contradict", () => {
    expect(problems({ ...HUB, EVENT_END_AT: "2026-12-25T22:00:00" }).join()).toMatch(
      /EVENT_END_AT must be a date and time with an offset/,
    );
    expect(problems({ ...HUB, EVENT_END_AT: "christmas" }).join()).toMatch(/EVENT_END_AT/);
    expect(problems({ ...HUB, HUB_UNPOSTED_HOURS: "0" }).join()).toMatch(/HUB_UNPOSTED_HOURS/);
    expect(
      problems({ ...HUB, HUB_UNPOSTED_HOURS: "100", PHOTO_RETENTION_DAYS: "2" }).join(),
    ).toMatch(/cannot be longer than PHOTO_RETENTION_DAYS/);
    expect(problems({ ...PROD, EVENT_END_AT: "2026-12-25T22:00:00+09:00" }).join()).toMatch(
      /EVENT_END_AT is for the hub/,
    );
  });

  // Found by the Phase 4 load run: 100000 minutes overflowed Node's timer and backed up every ms.
  it("backup interval: at most one day", () => {
    expect(parseServerConfig({ ...HUB, HUB_BACKUP_MINUTES: "1440" }).hubOps?.backupMinutes).toBe(
      1440,
    );
    expect(problems({ ...HUB, HUB_BACKUP_MINUTES: "100000" }).join()).toMatch(
      /HUB_BACKUP_MINUTES must be 1440/,
    );
  });
});

describe("isPrivateHost", () => {
  it.each([
    "localhost",
    "127.0.0.1",
    "10.0.0.1",
    "172.16.5.4",
    "192.168.1.1",
    "169.254.1.1",
    "::1",
    "fd12:3456::1",
    "kiosk.local",
  ])("%s is private", (h) => expect(isPrivateHost(h)).toBe(true));
  it.each(["lights.example.org", "8.8.8.8", "172.32.0.1", "2001:4860::8888"])("%s is public", (h) =>
    expect(isPrivateHost(h)).toBe(false),
  );
});

describe("AI review provider config (D95)", () => {
  const ACCOUNT = "0123456789abcdef0123456789abcdef";
  const CF = {
    AI_MODERATION_PROVIDER: "cloudflare",
    AI_MODERATION_API_KEY: "cf-token",
    AI_MODERATION_ACCOUNT_ID: ACCOUNT,
    AI_MODERATION_MODEL: "@cf/vendor/vision-model",
  };
  const ai = (env: Record<string, string | undefined>, base: Record<string, string> = PROD) => {
    const c = parseServerConfig({ ...base, ...env });
    return { config: c.aiModeration, problem: c.aiModerationProblem };
  };

  it("is off unless a provider is named, and that is not a problem", () => {
    expect(ai({})).toEqual({ config: null, problem: null });
    expect(ai({ AI_MODERATION_API_KEY: "left-over-key" })).toEqual({ config: null, problem: null });
  });

  it("Cloudflare Workers AI: account + token + model, with safe defaults", () => {
    expect(ai(CF)).toEqual({
      problem: null,
      config: {
        kind: "chat",
        id: "cloudflare",
        baseUrl: new URL(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1`),
        apiKey: "cf-token",
        model: "@cf/vendor/vision-model",
        dailyLimit: 300,
        timeoutMs: 8000,
      },
    });
    expect(
      ai({ ...CF, AI_MODERATION_DAILY_LIMIT: "120", AI_MODERATION_TIMEOUT_MS: "5000" }).config,
    ).toMatchObject({ dailyLimit: 120, timeoutMs: 5000 });
  });

  it("any other OpenAI-style endpoint needs an https base URL", () => {
    const other = {
      AI_MODERATION_PROVIDER: "openai-compatible",
      AI_MODERATION_API_KEY: "k",
      AI_MODERATION_MODEL: "vendor/vision-1",
      AI_MODERATION_BASE_URL: "https://api.example.com/openai/v1",
    };
    expect(ai(other).config).toMatchObject({ kind: "chat", id: "openai-compatible" });
    for (const bad of [
      "http://api.example.com/v1",
      "https://user:pw@api.example.com/v1",
      "https://api.example.com/v1?key=1",
      "https://192.168.0.5/v1",
      "https://localhost/v1",
      "not a url",
      "",
    ])
      expect(ai({ ...other, AI_MODERATION_BASE_URL: bad }), bad).toMatchObject({
        config: null,
        problem: expect.stringMatching(/BASE_URL/),
      });
  });

  it("Gemini is refused until the operator confirms the paid tier", () => {
    const g = { AI_MODERATION_PROVIDER: "gemini", AI_MODERATION_API_KEY: "g-key" };
    expect(ai(g)).toMatchObject({ config: null, problem: expect.stringMatching(/paid tier only/) });
    expect(ai({ ...g, AI_MODERATION_PAID_TIER_CONFIRMED: "yes" }).config).toBeNull();
    expect(ai({ ...g, AI_MODERATION_PAID_TIER_CONFIRMED: "1" })).toEqual({
      problem: null,
      config: {
        kind: "gemini",
        apiKey: "g-key",
        model: "gemini-3.5-flash-lite",
        dailyLimit: 300,
        timeoutMs: 8000,
      },
    });
  });

  it("the mock provider never runs on a real deployment", () => {
    expect(ai({ AI_MODERATION_PROVIDER: "mock" })).toMatchObject({
      config: null,
      problem: expect.stringMatching(/development and tests only/),
    });
    const dev = { ...SECRETS };
    expect(ai({ AI_MODERATION_PROVIDER: "mock" }, dev).config).toMatchObject({
      kind: "mock",
      behaviour: "safe",
    });
    expect(
      ai({ AI_MODERATION_PROVIDER: "mock", AI_MODERATION_MOCK: "unsafe" }, dev).config,
    ).toMatchObject({
      behaviour: "unsafe",
    });
    expect(
      ai({ AI_MODERATION_PROVIDER: "mock", AI_MODERATION_MOCK: "approve-all" }, dev).config,
    ).toBeNull();
  });

  it.each([
    [{ AI_MODERATION_PROVIDER: "chatgpt" }, /must be cloudflare/],
    [{ ...CF, AI_MODERATION_API_KEY: "" }, /API_KEY is missing/],
    [{ ...CF, AI_MODERATION_MODEL: undefined }, /MODEL is required/],
    [{ ...CF, AI_MODERATION_MODEL: "model with spaces" }, /MODEL has characters/],
    [{ ...CF, AI_MODERATION_ACCOUNT_ID: "my-account" }, /ACCOUNT_ID/],
    [{ ...CF, AI_MODERATION_ACCOUNT_ID: undefined }, /ACCOUNT_ID/],
    [{ ...CF, AI_MODERATION_DAILY_LIMIT: "0" }, /DAILY_LIMIT/],
    [{ ...CF, AI_MODERATION_DAILY_LIMIT: "unlimited" }, /DAILY_LIMIT/],
    [{ ...CF, AI_MODERATION_TIMEOUT_MS: "60000" }, /TIMEOUT_MS/],
    [{ ...CF, AI_MODERATION_TIMEOUT_MS: "10" }, /TIMEOUT_MS/],
  ])("a mistake turns the AI off and says why, without stopping the server: %j", (env, why) => {
    // No ConfigError: the booth, the QR and human review must keep working.
    const result = ai(env as Record<string, string | undefined>);
    expect(result.config).toBeNull();
    expect(result.problem).toMatch(why);
    // The problem text never repeats the key.
    expect(result.problem).not.toContain("cf-token");
  });
});
