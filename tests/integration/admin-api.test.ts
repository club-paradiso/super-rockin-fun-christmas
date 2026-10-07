// @vitest-environment node
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JPEG, uuid } from "../helpers/images";

/**
 * Staff + kiosk HTTP APIs against a REAL local Supabase (Auth, PostgREST, Storage, Mailpit).
 * Proves: OTP login, allowlist authorization, CSRF, kiosk/staff isolation, moderation through
 * HTTP, QR rotation, one-time enrollment, revocation, heartbeat, emergency pause semantics.
 */
const URL_ = process.env.SUPABASE_TEST_URL;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const MAILPIT = process.env.SUPABASE_TEST_MAILPIT_URL;
const enabled = !!(URL_ && SERVICE && ANON && MAILPIT);
const ORIGIN = "http://lights.test";

const service = () => createClient(URL_!, SERVICE!, { auth: { persistSession: false } });

beforeAll(() => {
  if (!enabled) return;
  Object.assign(process.env, {
    PHOTO_STORE: "supabase",
    SUPABASE_URL: URL_,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE,
    SUPABASE_ANON_KEY: ANON,
    KIOSK_SESSION_SECRET: "s".repeat(48),
    PUBLIC_BASE_URL: ORIGIN,
  });
  delete process.env.KIOSK_ENROLL_SECRET; // code-only enrollment (the Phase 3 model)
});

type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;
async function call(
  mod: Promise<Record<string, unknown>>,
  method: "GET" | "POST",
  path: string,
  opts: {
    cookie?: string;
    body?: unknown;
    raw?: BodyInit;
    headers?: Record<string, string>;
    params?: Record<string, string>;
  } = {},
) {
  const handler = (await mod)[method] as Handler;
  const headers: Record<string, string> = {
    origin: ORIGIN,
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
  };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return handler(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { ...headers, ...opts.headers },
      body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    }),
    { params: Promise.resolve(opts.params ?? {}) },
  );
}

const routes = {
  otp: () => import("@/app/api/admin/auth/otp/route"),
  verify: () => import("@/app/api/admin/auth/verify/route"),
  overview: () => import("@/app/api/admin/overview/route"),
  photos: () => import("@/app/api/admin/photos/route"),
  moderate: () => import("@/app/api/admin/photos/[id]/moderate/route"),
  rotate: () => import("@/app/api/admin/photos/[id]/rotate-token/route"),
  staffImage: () => import("@/app/api/admin/photos/[id]/image/route"),
  photoAudit: () => import("@/app/api/admin/photos/[id]/audit/route"),
  kiosks: () => import("@/app/api/admin/kiosks/route"),
  kiosk: () => import("@/app/api/admin/kiosks/[id]/route"),
  codes: () => import("@/app/api/admin/enrollment-codes/route"),
  settings: () => import("@/app/api/admin/settings/route"),
  staff: () => import("@/app/api/admin/staff/route"),
  staffMember: () => import("@/app/api/admin/staff/[userId]/route"),
  enroll: () => import("@/app/api/kiosk/enroll/route"),
  heartbeat: () => import("@/app/api/kiosk/heartbeat/route"),
  upload: () => import("@/app/api/photos/route"),
  consent: () => import("@/app/api/photos/consent/route"),
  guestImage: () => import("@/app/p/[token]/image/route"),
};

function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

async function createUser(email: string) {
  const { data, error } = await service().auth.admin.createUser({ email, email_confirm: true });
  if (error) throw error;
  return data.user.id;
}

/** Log in through OUR verify route with a code obtained via the admin API (no email needed). */
async function login(email: string) {
  const { data, error } = await service().auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  const res = await call(routes.verify(), "POST", "/api/admin/auth/verify", {
    body: { email, code: data.properties.email_otp },
  });
  return { res, cookie: cookieHeader(res) };
}

/** A raw Supabase session (cookie) for a user, bypassing our allowlist check at login. */
async function rawSessionCookie(email: string) {
  const { createServerClient } = await import("@supabase/ssr");
  const { data } = await service().auth.admin.generateLink({ type: "magiclink", email });
  const jar = new Map<string, string>();
  const client = createServerClient(URL_!, ANON!, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) =>
        list.forEach((c) => (c.value ? jar.set(c.name, c.value) : jar.delete(c.name))),
    },
  });
  const { data: session, error } = await client.auth.verifyOtp({
    email,
    token: data.properties!.email_otp,
    type: "email",
  });
  if (error) throw error;
  return {
    cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; "),
    accessToken: session.session!.access_token,
  };
}

describe.skipIf(!enabled)("staff + kiosk APIs on local Supabase", () => {
  const tag = uuid().slice(0, 8);
  const staffEmail = `staff-${tag}@example.org`;
  const outsiderEmail = `outsider-${tag}@example.org`;
  const inactiveEmail = `inactive-${tag}@example.org`;
  let staffId: string;
  let staffCookie: string;
  let kioskCookie: string;
  let kioskId: string;

  beforeAll(async () => {
    const { getBackend } = await import("@/lib/storage/server");
    staffId = await createUser(staffEmail);
    await createUser(outsiderEmail);
    const inactiveId = await createUser(inactiveEmail);
    await getBackend().staff.upsert(
      { userId: staffId, email: staffEmail, displayName: "검수 담당" },
      null,
    );
    await getBackend().staff.upsert(
      { userId: inactiveId, email: inactiveEmail, displayName: "퇴근", active: false },
      null,
    );
    const { res, cookie } = await login(staffEmail);
    expect(res.status).toBe(200);
    staffCookie = cookie;
  });

  afterAll(async () => {
    const { getBackend } = await import("@/lib/storage/server");
    await getBackend().settings.update({ pauseSubmissions: false }, staffId);
  });

  describe("staff authentication + authorization", () => {
    it("rejects unauthenticated requests", async () => {
      expect((await call(routes.overview(), "GET", "/api/admin/overview")).status).toBe(401);
      expect(
        (
          await call(routes.settings(), "POST", "/api/admin/settings", {
            body: { pauseWall: true },
          })
        ).status,
      ).toBe(401);
    });

    it("rejects an authenticated Supabase user who is not on the staff allowlist", async () => {
      const viaLogin = await login(outsiderEmail);
      expect(viaLogin.res.status).toBe(403);
      expect(viaLogin.cookie).toBe(""); // session cleared immediately
      const raw = await rawSessionCookie(outsiderEmail);
      const res = await call(routes.overview(), "GET", "/api/admin/overview", {
        cookie: raw.cookie,
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "not_staff" });
    });

    it("rejects a deactivated staff member", async () => {
      expect((await login(inactiveEmail)).res.status).toBe(403);
      const raw = await rawSessionCookie(inactiveEmail);
      const res = await call(routes.overview(), "GET", "/api/admin/overview", {
        cookie: raw.cookie,
      });
      expect(await res.json()).toEqual({ error: "inactive" });
    });

    it("accepts an active staff member", async () => {
      const res = await call(routes.overview(), "GET", "/api/admin/overview", {
        cookie: staffCookie,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ settings: { pauseSubmissions: false } });
    });

    it("deactivation takes effect on the very next request", async () => {
      const email = `temp-${tag}@example.org`;
      const id = await createUser(email);
      const add = await call(routes.staff(), "POST", "/api/admin/staff", {
        cookie: staffCookie,
        body: { email, displayName: "임시" },
      });
      expect(add.status).toBe(201);
      const { cookie } = await login(email);
      expect((await call(routes.overview(), "GET", "/api/admin/overview", { cookie })).status).toBe(
        200,
      );
      const off = await call(routes.staffMember(), "POST", `/api/admin/staff/${id}`, {
        cookie: staffCookie,
        body: { active: false },
        params: { userId: id },
      });
      expect(off.status).toBe(200);
      expect((await call(routes.overview(), "GET", "/api/admin/overview", { cookie })).status).toBe(
        403,
      );
    });

    it("refuses cross-origin and non-JSON staff mutations (CSRF)", async () => {
      expect(
        (
          await call(routes.settings(), "POST", "/api/admin/settings", {
            cookie: staffCookie,
            body: { pauseWall: true },
            headers: { origin: "https://evil.example" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call(routes.settings(), "POST", "/api/admin/settings", {
            cookie: staffCookie,
            raw: "pauseWall=true",
            headers: { "content-type": "application/x-www-form-urlencoded" },
          })
        ).status,
      ).toBe(415);
    });

    it("a Supabase user JWT gets no direct database access (RLS)", async () => {
      const raw = await rawSessionCookie(outsiderEmail);
      const asUser = createClient(URL_!, ANON!, {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${raw.accessToken}` } },
      });
      for (const table of [
        "photos",
        "staff_members",
        "audit_events",
        "event_settings",
        "kiosks",
        "kiosk_enrollment_codes",
      ]) {
        const r = await asUser.from(table).select("*").limit(1);
        expect(r.error ?? (r.data ?? []).length === 0).toBeTruthy();
        expect(r.data ?? []).toEqual([]);
      }
      expect(
        (
          await asUser.rpc("ftl_settings_update", {
            p_pause_submissions: true,
            p_pause_wall: null,
            p_show_holding_screen: null,
            p_actor_id: null,
          })
        ).error,
      ).not.toBeNull();
    });

    it("emails a login code only to active staff, with an identical response either way", async () => {
      const mails = async (to: string) => {
        const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
        return ((await r.json()) as { messages: { ID: string }[] }).messages;
      };
      const a = await call(routes.otp(), "POST", "/api/admin/auth/otp", {
        body: { email: staffEmail },
      });
      const b = await call(routes.otp(), "POST", "/api/admin/auth/otp", {
        body: { email: outsiderEmail },
      });
      expect([a.status, await a.json()]).toEqual([b.status, await b.json()]);
      await expect
        .poll(async () => (await mails(staffEmail)).length, { timeout: 10_000 })
        .toBeGreaterThan(0);
      const msg = await (
        await fetch(`${MAILPIT}/api/v1/message/${(await mails(staffEmail))[0]!.ID}`)
      ).json();
      expect(String(msg.Text)).toMatch(/\b\d{6}\b/);
      expect(await mails(outsiderEmail)).toHaveLength(0);
    });
  });

  describe("kiosk enrollment, heartbeat, revocation", () => {
    it("one-time code from staff enrolls a fresh kiosk exactly once", async () => {
      const created = await call(routes.codes(), "POST", "/api/admin/enrollment-codes", {
        cookie: staffCookie,
        body: { label: "본당 입구" },
      });
      expect(created.status).toBe(201);
      const { code } = (await created.json()) as { code: string };
      expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
      const first = await call(routes.enroll(), "POST", "/api/kiosk/enroll", { body: { code } });
      expect(first.status).toBe(201);
      kioskId = ((await first.json()) as { kioskId: string }).kioskId;
      kioskCookie = first.headers.get("set-cookie")!.split(";")[0]!;
      expect(
        (await call(routes.enroll(), "POST", "/api/kiosk/enroll", { body: { code } })).status,
      ).toBe(401);
      // The code is never listed back.
      const list = await (
        await call(routes.codes(), "GET", "/api/admin/enrollment-codes", { cookie: staffCookie })
      ).text();
      expect(list).not.toContain(code);
    });

    it("shared-secret enrollment is off unless configured", async () => {
      expect(
        (
          await call(routes.enroll(), "POST", "/api/kiosk/enroll", {
            body: { secret: "x".repeat(30), label: "x" },
          })
        ).status,
      ).toBe(401);
    });

    it("heartbeat updates last-seen and queue depth for staff", async () => {
      const hb = await call(routes.heartbeat(), "POST", "/api/kiosk/heartbeat", {
        cookie: kioskCookie,
        body: { queueDepth: 2, camera: "ok" },
      });
      expect(hb.status).toBe(200);
      expect(await hb.json()).toEqual({ wallSubmissions: "open" });
      const { kiosks } = (await (
        await call(routes.kiosks(), "GET", "/api/admin/kiosks", { cookie: staffCookie })
      ).json()) as {
        kiosks: { id: string; health: string; queueDepth: number; cameraState: string }[];
      };
      expect(kiosks.find((k) => k.id === kioskId)).toMatchObject({
        health: "online",
        queueDepth: 2,
        cameraState: "ok",
      });
    });

    it("kiosks and staff cannot stand in for each other", async () => {
      expect(
        (await call(routes.overview(), "GET", "/api/admin/overview", { cookie: kioskCookie }))
          .status,
      ).toBe(401);
      const asStaff = await call(routes.upload(), "POST", "/api/photos", {
        cookie: staffCookie,
        raw: JPEG,
        headers: {
          "content-type": "image/jpeg",
          "x-session-id": uuid(),
          "x-frame-id": "starlight-strip",
        },
      });
      expect(asStaff.status).toBe(401);
      expect(
        (
          await call(routes.heartbeat(), "POST", "/api/kiosk/heartbeat", {
            cookie: staffCookie,
            body: {},
          })
        ).status,
      ).toBe(401);
    });
  });

  describe("moderation, deletion, QR recovery, emergency pause", () => {
    async function shoot(consent: boolean) {
      const up = await call(routes.upload(), "POST", "/api/photos", {
        cookie: kioskCookie,
        raw: JPEG,
        headers: {
          "content-type": "image/jpeg",
          "x-session-id": uuid(),
          "x-frame-id": "starlight-strip",
        },
      });
      expect(up.status).toBe(201);
      const { token, wallSubmissions } = (await up.json()) as {
        token: string;
        wallSubmissions: string;
      };
      let consentStatus: number | null = null;
      if (consent) {
        consentStatus = (
          await call(routes.consent(), "POST", "/api/photos/consent", {
            cookie: kioskCookie,
            body: { token, consent: true },
          })
        ).status;
      }
      const { getBackend } = await import("@/lib/storage/server");
      const { hashToken } = await import("@/lib/storage/token");
      const row = await getBackend().photos.findByTokenHash(hashToken(token));
      // Staff find a session by its short code (shown on the kiosk QR screen).
      const { photos } = (await (
        await call(
          routes.photos(),
          "GET",
          `/api/admin/photos?window=1h&session=${row!.sessionId.slice(0, 8)}`,
          {
            cookie: staffCookie,
          },
        )
      ).json()) as { photos: { id: string; status: string }[] };
      expect(photos.map((p) => p.id)).toEqual([row!.id]);
      return { token, id: row!.id, objectPath: row!.objectPath, wallSubmissions, consentStatus };
    }
    const guestStatus = async (token: string) =>
      (await call(routes.guestImage(), "GET", `/p/${token}/image`, { params: { token } })).status;
    const moderate = (id: string, body: unknown) =>
      call(routes.moderate(), "POST", `/api/admin/photos/${id}/moderate`, {
        cookie: staffCookie,
        body,
        params: { id },
      });

    it("PENDING → APPROVED via API, with an audit event naming the staff member", async () => {
      const p = await shoot(true);
      const res = await moderate(p.id, { action: "approve", note: "좋아요" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ photo: { status: "APPROVED", wallEligible: true } });
      const { events } = (await (
        await call(routes.photoAudit(), "GET", `/api/admin/photos/${p.id}/audit`, {
          cookie: staffCookie,
          params: { id: p.id },
        })
      ).json()) as {
        events: { action: string; actorId: string; actorLabel: string; note: string }[];
      };
      expect(events[0]).toMatchObject({
        action: "approve",
        actorId: staffId,
        actorLabel: "검수 담당",
        note: "좋아요",
      });
    });

    it("REJECT keeps the guest download; no-consent photos cannot be approved", async () => {
      const p = await shoot(true);
      expect((await moderate(p.id, { action: "reject" })).status).toBe(200);
      expect(await guestStatus(p.token)).toBe(200);
      const q = await shoot(false);
      expect((await moderate(q.id, { action: "approve" })).status).toBe(409);
    });

    it("delete needs explicit confirmation, removes the image and kills the guest link", async () => {
      const p = await shoot(true);
      expect((await moderate(p.id, { action: "delete" })).status).toBe(400);
      expect(await guestStatus(p.token)).toBe(200);
      expect((await moderate(p.id, { action: "delete", confirm: "DELETE" })).status).toBe(200);
      expect(await guestStatus(p.token)).toBe(404);
      expect((await service().storage.from("photos").download(p.objectPath)).error).not.toBeNull();
      expect(
        (
          await call(routes.staffImage(), "GET", `/api/admin/photos/${p.id}/image`, {
            cookie: staffCookie,
            params: { id: p.id },
          })
        ).status,
      ).toBe(404);
      expect((await moderate(p.id, { action: "delete", confirm: "DELETE" })).status).toBe(200); // idempotent
      expect((await moderate(p.id, { action: "approve" })).status).toBe(410);
    });

    it("staff image proxy serves a small review copy without exposing storage paths", async () => {
      const p = await shoot(false);
      const res = await call(routes.staffImage(), "GET", `/api/admin/photos/${p.id}/image`, {
        cookie: staffCookie,
        params: { id: p.id },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(
        (
          await call(routes.staffImage(), "GET", `/api/admin/photos/${p.id}/image`, {
            params: { id: p.id },
          })
        ).status,
      ).toBe(401);
      const list = await (
        await call(routes.photos(), "GET", "/api/admin/photos?window=1h", { cookie: staffCookie })
      ).text();
      expect(list).not.toMatch(/objectPath|object_path|tokenHash|token_hash|\.jpg|[0-9a-f]{64}/);
      expect(list).not.toContain(p.token);
    });

    it("QR 다시 보여주기: new link works, old link stops", async () => {
      const p = await shoot(false);
      const res = await call(routes.rotate(), "POST", `/api/admin/photos/${p.id}/rotate-token`, {
        cookie: staffCookie,
        body: {},
        params: { id: p.id },
      });
      expect(res.status).toBe(200);
      const { url } = (await res.json()) as { url: string };
      expect(url.startsWith(`${ORIGIN}/p/`)).toBe(true);
      const newToken = url.split("/p/")[1]!;
      expect(await guestStatus(p.token)).toBe(404);
      expect(await guestStatus(newToken)).toBe(200);
    });

    it("PAUSE SUBMISSIONS blocks only new wall consent; photos and QR keep working", async () => {
      const outsider = await rawSessionCookie(outsiderEmail);
      expect(
        (
          await call(routes.settings(), "POST", "/api/admin/settings", {
            cookie: outsider.cookie,
            body: { pauseSubmissions: true },
          })
        ).status,
      ).toBe(403);
      const on = await call(routes.settings(), "POST", "/api/admin/settings", {
        cookie: staffCookie,
        body: { pauseSubmissions: true },
      });
      expect(on.status).toBe(200);
      const p = await shoot(true);
      expect(p.wallSubmissions).toBe("paused");
      expect(p.consentStatus).toBe(409);
      expect(await guestStatus(p.token)).toBe(200);
      expect(
        (
          await call(routes.consent(), "POST", "/api/photos/consent", {
            cookie: kioskCookie,
            body: { token: p.token, consent: false },
          })
        ).status,
      ).toBe(200);
      const hb = await call(routes.heartbeat(), "POST", "/api/kiosk/heartbeat", {
        cookie: kioskCookie,
        body: { queueDepth: 0 },
      });
      expect(await hb.json()).toEqual({ wallSubmissions: "paused" });
      await call(routes.settings(), "POST", "/api/admin/settings", {
        cookie: staffCookie,
        body: { pauseSubmissions: false },
      });
    });

    it("revoking a kiosk blocks it immediately (audited)", async () => {
      const res = await call(routes.kiosk(), "POST", `/api/admin/kiosks/${kioskId}`, {
        cookie: staffCookie,
        body: { action: "revoke" },
        params: { id: kioskId },
      });
      expect(res.status).toBe(200);
      const up = await call(routes.upload(), "POST", "/api/photos", {
        cookie: kioskCookie,
        raw: JPEG,
        headers: {
          "content-type": "image/jpeg",
          "x-session-id": uuid(),
          "x-frame-id": "starlight-strip",
        },
      });
      expect(up.status).toBe(401);
      expect(
        (
          await call(routes.heartbeat(), "POST", "/api/kiosk/heartbeat", {
            cookie: kioskCookie,
            body: {},
          })
        ).status,
      ).toBe(401);
    });
  });
});
