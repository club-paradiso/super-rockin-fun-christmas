import { describe, expect, it, vi } from "vitest";
import { sendWallConsent, uploadOnce } from "@/lib/kiosk/delivery";
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
  const noSleep = () => Promise.resolve();
  it("retries transient failures", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await sendWallConsent("t", true, fetchImpl, noSleep)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("does not retry a 4xx", async () => {
    const fetchImpl = respond(404);
    expect(await sendWallConsent("t", true, fetchImpl, noSleep)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("QR", () => {
  it("renders an SVG", async () => {
    expect((await makeQrSvg("https://lights.example.org/p/abc")).startsWith("<svg")).toBe(true);
  });
});
