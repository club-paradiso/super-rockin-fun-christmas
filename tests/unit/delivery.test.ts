import { describe, expect, it, vi } from "vitest";
import { uploadFinalImage } from "@/lib/kiosk/delivery";
import { buildDownloadUrl, makeQrSvg, publicOrigin } from "@/lib/qr";

const input = () => ({
  blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }),
  sessionId: "11111111-2222-4333-8444-555555555555",
  frameId: "starlight-strip",
});
const ok = { token: "t", path: "/p/t", expiresAt: "e", duplicate: false };
const noSleep = () => Promise.resolve();

describe("uploadFinalImage", () => {
  it("retries network errors with the same session id", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(new Response(JSON.stringify(ok), { status: 201 }));
    await expect(uploadFinalImage(input(), fetchImpl, noSleep)).resolves.toEqual(ok);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const ids = fetchImpl.mock.calls.map(
      (c) => (c[1] as RequestInit & { headers: Record<string, string> }).headers["x-session-id"],
    );
    expect(new Set(ids).size).toBe(1);
  });

  it("does not retry a 4xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 400 }));
    await expect(uploadFinalImage(input(), fetchImpl, noSleep)).rejects.toThrow("400");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("gives up after three attempts", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    await expect(uploadFinalImage(input(), fetchImpl, noSleep)).rejects.toThrow("503");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("QR", () => {
  it("builds the download URL from the public origin", () => {
    expect(buildDownloadUrl("https://lights.example.org", "abc_-")).toBe(
      "https://lights.example.org/p/abc_-",
    );
    expect(publicOrigin("", "http://kiosk.local:3000")).toBe("http://kiosk.local:3000");
    expect(publicOrigin(" https://a.b ", "x")).toBe("https://a.b");
  });

  it("renders an SVG", async () => {
    const svg = await makeQrSvg("https://lights.example.org/p/abc");
    expect(svg.startsWith("<svg")).toBe(true);
  });
});
