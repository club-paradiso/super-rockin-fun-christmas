import { describe, expect, it, vi } from "vitest";
import { requestQr, sendWallConsent, uploadOnce } from "@/lib/kiosk/delivery";
import { makeQrSvg } from "@/lib/qr";
import { JPEG, SESSION } from "../helpers/images";

const entry = {
  sessionId: SESSION,
  frameId: "starlight-strip",
  mime: "image/jpeg" as const,
  data: JPEG.buffer,
};
const respond = (status: number, body: unknown = {}) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe("uploadOnce", () => {
  it("sends the session id as idempotency key and no secrets", async () => {
    const fetchImpl = respond(201, {
      token: "t",
      url: "https://x/p/t",
      expiresAt: "e",
      duplicate: false,
    });
    const outcome = await uploadOnce(entry, 2, fetchImpl);
    expect(outcome).toMatchObject({ ok: true, result: { url: "https://x/p/t" } });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers["x-session-id"]).toBe(SESSION);
    expect(init.headers["x-queue-depth"]).toBe("2");
    expect(init.credentials).toBe("same-origin");
    expect(Object.keys(init.headers).join()).not.toMatch(/auth|secret|key/i);
  });

  it("202 from a hub = stored, QR pending (not a retry)", async () => {
    const fetchImpl = respond(202, { qr: "pending", duplicate: false, wallSubmissions: "open" });
    expect(await uploadOnce(entry, 0, fetchImpl)).toEqual({
      ok: true,
      result: { qr: "pending", duplicate: false, wallSubmissions: "open", qrPending: true },
    });
  });

  it.each([
    [401, "auth"],
    [409, "conflict"],
    [400, "rejected"],
    [413, "rejected"],
    [415, "rejected"],
    [429, "server"],
    [502, "server"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    expect(await uploadOnce(entry, 0, respond(status))).toMatchObject({ ok: false, kind });
  });

  it("maps a thrown fetch to network", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await uploadOnce(entry, 0, fetchImpl)).toMatchObject({ ok: false, kind: "network" });
  });
});

describe("sendWallConsent", () => {
  it("sends the session id, never a token", async () => {
    const fetchImpl = respond(200);
    expect(await sendWallConsent("s-1", true, fetchImpl)).toBe("done");
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ sessionId: "s-1", consent: true });
  });

  it.each([
    [401, "retry"],
    [429, "retry"],
    [500, "retry"],
    [503, "retry"],
    [400, "done"],
    [404, "done"],
    [409, "done"],
  ])("HTTP %i → %s", async (status, expected) => {
    expect(await sendWallConsent("s", true, respond(status))).toBe(expected);
  });

  it("a thrown fetch (offline) → retry", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("offline"));
    expect(await sendWallConsent("s", false, fetchImpl)).toBe("retry");
  });
});

describe("QR", () => {
  it("renders an SVG", async () => {
    expect((await makeQrSvg("https://lights.example.org/p/abc")).startsWith("<svg")).toBe(true);
  });
});

describe("requestQr", () => {
  it("returns the link on 200 and null while pending or on errors", async () => {
    const link = { token: "t", url: "https://x/p/t", expiresAt: "e" };
    expect(await requestQr("s", respond(200, link))).toEqual(link);
    expect(await requestQr("s", respond(202, { qr: "pending" }))).toBeNull();
    expect(await requestQr("s", respond(500))).toBeNull();
    expect(await requestQr("s", vi.fn().mockRejectedValue(new TypeError("offline")))).toBeNull();
    const fetchImpl = respond(202, { qr: "pending" });
    await requestQr("s-1", fetchImpl);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toEqual({ sessionId: "s-1" });
  });
});
