import { describe, expect, it } from "vitest";
import { cameraLabEnabled } from "@/lib/camera-engine/lab-gate";

describe("/camera-lab is a staff tool, not a guest page", () => {
  it("is served in development and on preview deployments", () => {
    expect(cameraLabEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(cameraLabEnabled({ NODE_ENV: "production", VERCEL_ENV: "preview" })).toBe(true);
  });

  it("is a 404 on a production deployment unless someone asks for it", () => {
    expect(cameraLabEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(cameraLabEnabled({ NODE_ENV: "production", VERCEL_ENV: "production" })).toBe(false);
    expect(cameraLabEnabled({ NODE_ENV: "production", CAMERA_LAB: "1" })).toBe(true);
  });

  it("can be turned off everywhere", () => {
    expect(cameraLabEnabled({ NODE_ENV: "development", CAMERA_LAB: "0" })).toBe(false);
    expect(
      cameraLabEnabled({ NODE_ENV: "production", VERCEL_ENV: "preview", CAMERA_LAB: "0" }),
    ).toBe(false);
  });
});
