// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HELP_CLOSED, helpReducer, type HelpAction, type HelpState } from "@/lib/kiosk/help";

/**
 * Staff help mode on the booth (docs/ARCHITECTURE.md 1.9): the pure panel reducer, and
 * /api/kiosk/help through the real route handlers on a hub (kiosk cookie AND a staff PIN; no staff
 * session comes out of it; the PIN guessing limit is shared with the staff login).
 */
const run = (actions: HelpAction[], from: HelpState = HELP_CLOSED) =>
  actions.reduce(helpReducer, from);
const ANNA = { userId: "11111111-1111-4111-8111-111111111111", displayName: "안나" };
const BEN = { userId: "22222222-2222-4222-8222-222222222222", displayName: "벤" };

describe("help panel reducer", () => {
  it("corner hold → names → PIN → menu", () => {
    const s = run([
      { type: "OPEN" },
      { type: "STAFF_LOADED", staff: [ANNA, BEN] },
      { type: "PICK", userId: BEN.userId },
      { type: "PIN", pin: "482913" },
      { type: "CHECKING" },
      { type: "UNLOCKED", displayName: "벤" },
    ]);
    expect(s).toEqual({ step: "menu", displayName: "벤" });
  });

  it("the PIN takes six digits only and is asked about only when complete", () => {
    const base = run([
      { type: "OPEN" },
      { type: "STAFF_LOADED", staff: [ANNA] },
      { type: "PICK", userId: ANNA.userId },
    ]);
    expect(run([{ type: "PIN", pin: "12a34567890" }], base)).toMatchObject({ pin: "123456" });
    expect(run([{ type: "PIN", pin: "123" }, { type: "CHECKING" }], base)).toMatchObject({
      checking: false,
    });
    // Unlocking needs an answer to a check that was actually asked.
    expect(run([{ type: "UNLOCKED", displayName: "x" }], base).step).toBe("pin");
  });

  it("a refusal clears the PIN and says why; typing is ignored while checking", () => {
    const checking = run([
      { type: "OPEN" },
      { type: "STAFF_LOADED", staff: [ANNA] },
      { type: "PICK", userId: ANNA.userId },
      { type: "PIN", pin: "000001" },
      { type: "CHECKING" },
    ]);
    expect(run([{ type: "PIN", pin: "9" }], checking)).toMatchObject({ pin: "000001" });
    expect(run([{ type: "DENIED", reason: "locked" }], checking)).toMatchObject({
      step: "pin",
      pin: "",
      checking: false,
      denied: "locked",
    });
  });

  it("unknown names, back, failure to load, and close from anywhere", () => {
    const pick = run([{ type: "OPEN" }, { type: "STAFF_LOADED", staff: [ANNA] }]);
    expect(run([{ type: "PICK", userId: BEN.userId }], pick)).toBe(pick);
    expect(run([{ type: "PICK", userId: ANNA.userId }, { type: "BACK" }], pick)).toMatchObject({
      step: "pick",
      staff: [ANNA],
    });
    expect(run([{ type: "OPEN" }, { type: "STAFF_FAILED" }])).toMatchObject({ failed: true });
    expect(run([{ type: "CLOSE" }], { step: "menu", displayName: "벤" })).toEqual(HELP_CLOSED);
    expect(run([{ type: "PICK", userId: ANNA.userId }])).toEqual(HELP_CLOSED);
  });
});

const ORIGIN = "http://192.168.0.10:3000";
const ENROLL = "enroll-secret-for-tests-only";
let dir: string;
let kiosk = "";
let staffCookie = "";
let staffId = "";
let otherId = "";

const post = (url: string, body: unknown, cookie?: string, origin = ORIGIN) =>
  new Request(`${ORIGIN}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const get = (url: string, cookie?: string) =>
  new Request(`${ORIGIN}${url}`, { headers: cookie ? { cookie } : {} });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
const help = () => import("@/app/api/kiosk/help/route");
const unlock = async (userId: string, pin: string, cookie = kiosk, origin = ORIGIN) =>
  (await help()).POST(post("/api/kiosk/help", { userId, pin }, cookie, origin));

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-help-"));
  Object.assign(process.env, {
    FTL_ROLE: "hub",
    FTL_DATA_DIR: dir,
    PHOTO_STORE: "local",
    KIOSK_SESSION_SECRET: "s".repeat(48),
    KIOSK_ENROLL_SECRET: ENROLL,
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const { POST: enroll } = await import("@/app/api/kiosk/enroll/route");
  kiosk = cookieOf(await enroll(post("/api/kiosk/enroll", { secret: ENROLL, label: "부스" })));
  const { addPinStaffMember } = await import("@/lib/ops/staff-admin");
  staffId = (await addPinStaffMember("책임자", "482913", null)).userId;
  otherId = (await addPinStaffMember("도우미", "715203", null)).userId;
  const { POST: login } = await import("@/app/api/admin/auth/pin/route");
  staffCookie = cookieOf(
    await login(post("/api/admin/auth/pin", { userId: staffId, pin: "482913" })),
  );
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("/api/kiosk/help on the hub", () => {
  it("only an enrolled booth may ask; a staff session is not a kiosk", async () => {
    const { GET } = await help();
    expect((await GET(get("/api/kiosk/help"))).status).toBe(401);
    expect((await GET(get("/api/kiosk/help", staffCookie))).status).toBe(401);
    expect((await unlock(staffId, "482913", staffCookie)).status).toBe(401);
    expect((await unlock(staffId, "482913", kiosk, "http://evil.example")).status).toBe(403);
  });

  it("lists active staff names, nothing about PINs", async () => {
    const res = await (await help()).GET(get("/api/kiosk/help", kiosk));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { staff: { userId: string; displayName: string }[] };
    expect(body.staff.map((s) => s.displayName).sort()).toEqual(["도우미", "책임자"]);
    expect(JSON.stringify(body)).not.toMatch(/hash|pin|scrypt|email/i);
  });

  it("right PIN → the name, and no staff cookie; wrong PIN → 401", async () => {
    const ok = await unlock(staffId, "482913");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ displayName: "책임자" });
    expect(ok.headers.get("set-cookie")).toBeNull();
    expect((await unlock(staffId, "000001")).status).toBe(401);
    expect((await unlock("not-a-uuid", "482913")).status).toBe(400);
  });

  it("guesses on the booth count against the same limit as the staff login", async () => {
    for (let i = 0; i < 5; i++) expect((await unlock(otherId, "000002")).status).toBe(401);
    expect((await unlock(otherId, "715203")).status).toBe(429);
    const { POST: login } = await import("@/app/api/admin/auth/pin/route");
    const res = await login(post("/api/admin/auth/pin", { userId: otherId, pin: "715203" }));
    expect(res.status).toBe(429);
  });
});
