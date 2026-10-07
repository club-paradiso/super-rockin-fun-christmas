// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ConfigError, isPrivateHost, parseServerConfig } from "@/lib/server/env";

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
    expect(problems({ ...PROD, KIOSK_ENROLL_SECRET: "short" }).join()).toMatch(
      /KIOSK_ENROLL_SECRET/,
    );
    const same = "x".repeat(40);
    expect(
      problems({ ...PROD, KIOSK_SESSION_SECRET: same, KIOSK_ENROLL_SECRET: same }).join(),
    ).toMatch(/differ/);
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
