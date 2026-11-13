import { describe, expect, it, vi } from "vitest";
import {
  deliverVideo,
  requestQr,
  sendWallConsent,
  uploadOnce,
  uploadVideoOnce,
} from "@/lib/kiosk/delivery";
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
    expect(await sendWallConsent("s-1", true, undefined, fetchImpl)).toBe("done");
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
    expect(await sendWallConsent("s", true, undefined, respond(status))).toBe(expected);
  });

  it("a thrown fetch (offline) → retry", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("offline"));
    expect(await sendWallConsent("s", false, undefined, fetchImpl)).toBe("retry");
  });

  // D86: the scope travels with a YES only; a NO never claims anything.
  it("sends the public scope with a yes, and never with a no", async () => {
    const yes = respond(200);
    await sendWallConsent("s-2", true, "public", yes);
    expect(JSON.parse(yes.mock.calls[0]![1].body)).toEqual({
      sessionId: "s-2",
      consent: true,
      scope: "public",
    });
    const no = respond(200);
    await sendWallConsent("s-2", false, "public", no);
    expect(JSON.parse(no.mock.calls[0]![1].body)).toEqual({ sessionId: "s-2", consent: false });
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

describe("session video delivery (D72): best-effort, never queued", () => {
  const video = { mime: "video/mp4", blob: new Blob([new Uint8Array(8)], { type: "video/mp4" }) };

  it("sends the bytes with the session id and the kiosk cookie only", async () => {
    const fetchImpl = respond(201, { ok: true });
    expect(await uploadVideoOnce(SESSION, video, fetchImpl)).toBe("done");
    const [url, init] = fetchImpl.mock.calls[0]! as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe("/api/photos/video");
    expect(init.headers).toEqual({ "content-type": "video/mp4", "x-session-id": SESSION });
    expect(init.credentials).toBe("same-origin");
    expect(init.body).toBe(video.blob);
  });

  it.each([
    [200, "done"],
    [404, "retry"], // the photo may not have landed yet
    [429, "retry"],
    [502, "retry"],
    [400, "dropped"],
    [401, "dropped"],
    [409, "dropped"],
    [413, "dropped"],
    [415, "dropped"],
  ])("HTTP %i → %s", async (status, outcome) => {
    expect(await uploadVideoOnce(SESSION, video, respond(status))).toBe(outcome);
  });

  it("a network error is worth another try", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await uploadVideoOnce(SESSION, video, fetchImpl)).toBe("retry");
  });

  it("retries a few times, then gives up quietly with one console line", async () => {
    const send = vi.fn().mockResolvedValue("retry");
    const warn = vi.fn();
    const slept: number[] = [];
    const ok = await deliverVideo(SESSION, video, {
      send,
      warn,
      delaysMs: [10, 20],
      sleep: async (ms) => void slept.push(ms),
    });
    expect(ok).toBe(false);
    expect(send).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([10, 20]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).not.toContain(SESSION);
  });

  it("stops at once when the server will never take it, and when it succeeds", async () => {
    const warn = vi.fn();
    const dropped = vi.fn().mockResolvedValue("dropped");
    expect(await deliverVideo(SESSION, video, { send: dropped, warn, sleep: async () => {} })).toBe(
      false,
    );
    expect(dropped).toHaveBeenCalledTimes(1);
    const later = vi.fn().mockResolvedValueOnce("retry").mockResolvedValueOnce("done");
    expect(await deliverVideo(SESSION, video, { send: later, warn, sleep: async () => {} })).toBe(
      true,
    );
    expect(later).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
