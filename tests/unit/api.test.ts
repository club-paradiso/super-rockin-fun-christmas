// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;
const SESSION = "11111111-2222-4333-8444-555555555555";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ftl-api-"));
  process.env.FTL_DATA_DIR = dir;
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const upload = async (body: BodyInit, headers: Record<string, string> = {}) => {
  const { POST } = await import("@/app/api/photos/route");
  return POST(
    new Request("http://k/api/photos", {
      method: "POST",
      body,
      headers: {
        "content-type": "image/jpeg",
        "x-session-id": SESSION,
        "x-frame-id": "starlight-strip",
        ...headers,
      },
    }),
  );
};

describe("photo API", () => {
  it("uploads, serves by token, and records consent independently", async () => {
    const res = await upload(JPEG);
    expect(res.status).toBe(201);
    const { token, path: link } = await res.json();
    expect(link).toBe(`/p/${token}`);
    expect(JSON.stringify(await (await upload(JPEG)).json())).toContain(token); // idempotent

    const { GET } = await import("@/app/p/[token]/image/route");
    const img = await GET(new Request(`http://k/p/${token}/image?download=1`), {
      params: Promise.resolve({ token }),
    });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(img.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(JPEG);

    const { POST: consent } = await import("@/app/api/photos/consent/route");
    const c = await consent(
      new Request("http://k", { method: "POST", body: JSON.stringify({ token, consent: true }) }),
    );
    expect(await c.json()).toEqual({ wall: "PENDING" });
    const again = await GET(new Request(`http://k/p/${token}/image`), {
      params: Promise.resolve({ token }),
    });
    expect(again.status).toBe(200);
  });

  it("rejects bad input", async () => {
    expect((await upload(JPEG, { "content-type": "text/plain" })).status).toBe(415);
    expect((await upload(JPEG, { "x-session-id": "1" })).status).toBe(400);
    expect((await upload(JPEG, { "x-frame-id": "nope" })).status).toBe(400);
    expect((await upload(new Uint8Array([1, 2, 3]))).status).toBe(400);
  });

  it("404s unknown tokens", async () => {
    const { GET } = await import("@/app/p/[token]/image/route");
    const token = "A".repeat(32);
    expect(
      (await GET(new Request("http://k"), { params: Promise.resolve({ token }) })).status,
    ).toBe(404);
  });
});
