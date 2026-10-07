// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BodyTooLargeError,
  hasImageSignature,
  isSameOrigin,
  readBodyLimited,
} from "@/lib/server/request";

const req = (headers: Record<string, string>) =>
  new Request("https://lights.example.org/api/photos", { method: "POST", headers });

describe("isSameOrigin (CSRF)", () => {
  it("accepts the server's own origin and the configured public origin", () => {
    expect(isSameOrigin(req({ origin: "https://lights.example.org" }))).toBe(true);
    expect(
      isSameOrigin(req({ origin: "https://alias.example.org" }), [
        new URL("https://alias.example.org"),
      ]),
    ).toBe(true);
  });

  it("refuses other origins", () => {
    expect(isSameOrigin(req({ origin: "https://evil.example" }))).toBe(false);
  });

  it("handles opaque `Origin: null` via fetch metadata only", () => {
    // Regression: a no-referrer policy made Chrome send Origin: null on the enrollment form.
    expect(isSameOrigin(req({ origin: "null", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOrigin(req({ origin: "null", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOrigin(req({ origin: "null" }))).toBe(false);
  });

  it("without Origin, refuses explicit cross-site fetch metadata", () => {
    expect(isSameOrigin(req({}))).toBe(true); // curl / server-to-server
    expect(isSameOrigin(req({ "sec-fetch-site": "cross-site" }))).toBe(false);
  });
});

describe("body and signature checks", () => {
  it("stops reading past the cap even when Content-Length lies", async () => {
    const r = new Request("https://x", { method: "POST", body: new Uint8Array(2048) });
    await expect(readBodyLimited(r, 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("JPEG needs SOI and EOI; PNG needs its signature", () => {
    expect(hasImageSignature(new Uint8Array([0xff, 0xd8, 0xff, 0, 0xff, 0xd9]), "image/jpeg")).toBe(
      true,
    );
    expect(hasImageSignature(new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0]), "image/jpeg")).toBe(
      false,
    );
    expect(
      hasImageSignature(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
        "image/png",
      ),
    ).toBe(true);
    expect(hasImageSignature(new Uint8Array([0xff, 0xd8, 0xff, 0, 0xff, 0xd9]), "image/png")).toBe(
      false,
    );
  });
});
