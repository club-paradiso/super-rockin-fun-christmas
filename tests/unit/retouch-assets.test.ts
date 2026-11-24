import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RETOUCH_CONFIG } from "@/config/retouch";

/**
 * The face model and its runtime are served by the booth itself (public/retouch): the venue's
 * network is not to be trusted and no CDN is used. These tests hold the files to what was
 * audited (docs/research/skin-retouch-audit.md): the non-SIMD build of MediaPipe 0.10.21, which
 * is the one Safari 15 on the iPad mini 4 can load.
 */
const root = path.resolve(import.meta.dirname, "../..");
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const publicFile = (url: string) => path.join(root, "public", url);

describe("self-hosted face model and runtime", () => {
  const d = RETOUCH_CONFIG.detection;

  it("has every file the config names, under this server's own /retouch path", () => {
    for (const url of [
      d.wasmLoaderPath,
      d.wasmBinaryPath,
      d.landmarkerModelPath,
      d.detectorModelPath,
    ]) {
      expect(url.startsWith("/retouch/")).toBe(true);
      expect(existsSync(publicFile(url)), url).toBe(true);
      expect(statSync(publicFile(url)).size).toBeGreaterThan(1000);
    }
  });

  it("serves the very runtime files of the pinned @mediapipe/tasks-vision package", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(root, "node_modules/@mediapipe/tasks-vision/package.json"), "utf8"),
    ) as { version: string };
    // 1.2.2 and later ship a SIMD-only binary; Safari 15 has no WebAssembly SIMD.
    expect(pkg.version).toBe("0.10.21");
    const deps = (
      JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      }
    ).dependencies;
    // Exact: a caret range would let the runtime drift away from the files in public/.
    expect(deps["@mediapipe/tasks-vision"]).toBe("0.10.21");
    for (const name of ["vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"]) {
      const published = path.join(root, "node_modules/@mediapipe/tasks-vision/wasm", name);
      expect(sha256(publicFile(`/retouch/mediapipe/${name}`)), name).toBe(sha256(published));
    }
  });

  it("uses the non-SIMD build and no other", () => {
    expect(d.wasmBinaryPath).toContain("nosimd");
    expect(d.wasmLoaderPath).toContain("nosimd");
    // A WebAssembly module: "\0asm", version 1.
    const head = readFileSync(publicFile(d.wasmBinaryPath)).subarray(0, 8);
    expect([...head]).toEqual([0, 97, 115, 109, 1, 0, 0, 0]);
  });

  it("has the models that were downloaded and checked on 2026-11-24", () => {
    expect(sha256(publicFile(d.landmarkerModelPath))).toBe(
      "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
    );
    expect(sha256(publicFile(d.detectorModelPath))).toBe(
      "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f",
    );
  });

  it("carries the licence notice of what it redistributes", () => {
    const notice = readFileSync(publicFile("/retouch/NOTICE.md"), "utf8");
    expect(notice).toContain("Apache License, Version 2.0");
    expect(notice).toContain("0.10.21");
  });
});
