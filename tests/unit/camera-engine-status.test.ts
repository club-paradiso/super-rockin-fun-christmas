import { describe, expect, it } from "vitest";
import {
  ENGINE_BACKEND_LABEL,
  ENGINE_BACKENDS,
  ENGINE_REASON_LABEL,
  ENGINE_REASONS,
  ENGINE_STATE_LABEL,
  ENGINE_STATES,
  PROFILE_SOURCE_LABEL,
  PROFILE_SOURCES,
  SENSOR_PERMISSION_LABEL,
  SENSOR_PERMISSIONS,
  SENSOR_STATE_LABEL,
  SENSOR_STATES,
  engineStatusLine,
  engineStatusRows,
  parseCameraEngineStatus,
  type CameraEngineStatus,
} from "@/lib/camera-engine/status";

const good: CameraEngineStatus = {
  state: "reduced",
  reason: "guard",
  permission: "granted",
  sensor: "ok",
  backend: "webgl",
  roll: 2.4,
  pitch: 11.5,
  appliedRoll: 2.4,
  appliedPitch: 6.1,
  strength: 0.53,
  zoom: 1.08,
  loss: 0.12,
  confidence: 0.97,
  profile: "generic-front",
  profileSource: "assumed",
  locked: false,
  previewMatches: true,
  pitchWarning: false,
  error: null,
};

describe("camera engine status: what the server accepts from a heartbeat", () => {
  it("accepts a valid status as it is", () => {
    expect(parseCameraEngineStatus(good)).toEqual(good);
    expect(parseCameraEngineStatus(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it("accepts every state, reason, permission, sensor state, backend and profile source", () => {
    for (const state of ENGINE_STATES)
      expect(parseCameraEngineStatus({ ...good, state })?.state).toBe(state);
    for (const reason of ENGINE_REASONS)
      expect(parseCameraEngineStatus({ ...good, reason })?.reason).toBe(reason);
    for (const permission of SENSOR_PERMISSIONS)
      expect(parseCameraEngineStatus({ ...good, permission })?.permission).toBe(permission);
    for (const sensor of SENSOR_STATES)
      expect(parseCameraEngineStatus({ ...good, sensor })?.sensor).toBe(sensor);
    for (const backend of ENGINE_BACKENDS)
      expect(parseCameraEngineStatus({ ...good, backend })?.backend).toBe(backend);
    for (const profileSource of PROFILE_SOURCES)
      expect(parseCameraEngineStatus({ ...good, profileSource })?.profileSource).toBe(
        profileSource,
      );
  });

  it("rounds: angles to 0.1°, shares and zoom to 0.01", () => {
    expect(
      parseCameraEngineStatus({
        ...good,
        roll: -3.04999,
        pitch: 11.9501,
        appliedRoll: -3.04999,
        appliedPitch: 6.149,
        strength: 0.5149,
        zoom: 1.07499,
        loss: 0.1251,
        confidence: 0.9949,
      }),
    ).toEqual({
      ...good,
      roll: -3,
      pitch: 12,
      appliedRoll: -3,
      appliedPitch: 6.1,
      strength: 0.51,
      zoom: 1.07,
      loss: 0.13,
      confidence: 0.99,
    });
    // No floating-point tails after rounding (these are stored and shown as they are).
    const out = parseCameraEngineStatus({ ...good, roll: 0.30000000000000004, zoom: 1.1 })!;
    expect(String(out.roll)).toBe("0.3");
    expect(String(out.zoom)).toBe("1.1");
  });

  it("keeps a missing tilt as null, and null/undefined reason and error as null", () => {
    expect(parseCameraEngineStatus({ ...good, roll: null, pitch: null })).toMatchObject({
      roll: null,
      pitch: null,
    });
    const { reason: _reason, error: _error, roll: _roll, ...rest } = good;
    void _reason;
    void _error;
    void _roll;
    expect(parseCameraEngineStatus(rest)).toEqual({
      ...good,
      reason: null,
      error: null,
      roll: null,
    });
    expect(parseCameraEngineStatus({ ...good, error: "context-lost" })?.error).toBe("context-lost");
  });

  it("drops everything that is not part of the contract", () => {
    const out = parseCameraEngineStatus({
      ...good,
      gravity: [0.1, 9.7, 0.4],
      samples: [1, 2, 3],
      userAgent: "x",
    });
    expect(out).toEqual(good);
    expect(Object.keys(out!).sort()).toEqual(Object.keys(good).sort());
  });

  it("refuses the whole status when anything is outside the contract", () => {
    for (const raw of [undefined, null, 0, "full", true, [], [good]])
      expect(parseCameraEngineStatus(raw)).toBeNull();
    const bad: Partial<Record<keyof CameraEngineStatus, unknown[]>> = {
      state: ["perfect", undefined, null, 1],
      reason: ["because", 1, ""],
      permission: ["yes", undefined, null],
      sensor: ["fine", undefined],
      backend: ["webgl2", undefined],
      roll: [181, -181, "2", Number.NaN, Infinity],
      pitch: [91, -91, "2", true],
      appliedRoll: [91, -91, null, undefined, "1"],
      appliedPitch: [91, -91, null, undefined],
      strength: [-0.01, 1.01, null, undefined],
      zoom: [0.99, 10.1, null, undefined],
      loss: [-0.01, 1.01, null, undefined],
      confidence: [-0.01, 1.01, null, undefined],
      profile: ["", "Generic Front", "a".repeat(41), 3, undefined, null, "<b>"],
      profileSource: ["guessed", undefined, null],
      locked: ["true", 0, undefined, null],
      previewMatches: ["true", 1, undefined, null],
      pitchWarning: ["no", 0, undefined, null],
      error: ["Context Lost", "text with spaces", "a-b-c-d-e-f", "", 5, "<script>", "a_b"],
    };
    for (const [key, values] of Object.entries(bad))
      for (const value of values!)
        expect(
          parseCameraEngineStatus({ ...good, [key]: value }),
          `${key}=${String(value)}`,
        ).toBeNull();
  });
});

describe("camera engine status: staff Korean", () => {
  it("has a label for every code", () => {
    for (const state of ENGINE_STATES) expect(ENGINE_STATE_LABEL[state]).toBeTruthy();
    for (const reason of ENGINE_REASONS) expect(ENGINE_REASON_LABEL[reason]).toBeTruthy();
    for (const p of SENSOR_PERMISSIONS) expect(SENSOR_PERMISSION_LABEL[p]).toBeTruthy();
    for (const s of SENSOR_STATES) expect(SENSOR_STATE_LABEL[s]).toBeTruthy();
    for (const b of ENGINE_BACKENDS) expect(ENGINE_BACKEND_LABEL[b]).toBeTruthy();
    for (const s of PROFILE_SOURCES) expect(PROFILE_SOURCE_LABEL[s]).toBeTruthy();
    expect(Object.keys(ENGINE_STATE_LABEL).sort()).toEqual([...ENGINE_STATES].sort());
    expect(Object.keys(ENGINE_REASON_LABEL).sort()).toEqual([...ENGINE_REASONS].sort());
  });

  it("the one line is the state, with the reason when there is one", () => {
    for (const state of ENGINE_STATES) {
      expect(engineStatusLine({ ...good, state, reason: null })).toBe(ENGINE_STATE_LABEL[state]);
      for (const reason of ENGINE_REASONS) {
        const line = engineStatusLine({ ...good, state, reason });
        expect(line).toContain(ENGINE_STATE_LABEL[state]);
        expect(line).toContain(ENGINE_REASON_LABEL[reason]);
      }
    }
  });

  it("the rows give signed angles, call them estimates, and add warnings only when needed", () => {
    const rows = engineStatusRows(good);
    const text = rows.map((r) => `${r.label}: ${r.value}`).join("\n");
    expect(text).toContain("좌우 +2.4° · 앞뒤 +11.5°");
    expect(text).toContain("앞뒤 +6.1° (앞뒤 53%)");
    expect(text).toContain("1.08배 · 12%");
    expect(text).toContain("신뢰도 97%");
    expect(text).toContain("generic-front (추정값)");
    expect(text).toContain("자동 감지 중");
    // Angles are sensor estimates, never a measurement of the photo.
    expect(rows[0]!.label).toContain("추정");
    expect(text).not.toMatch(/측정|정확/);
    expect(rows.some((r) => r.label === "주의")).toBe(false);
    expect(rows.some((r) => r.label === "마지막 오류")).toBe(false);
    expect(new Set(rows.map((r) => r.label)).size).toBe(rows.length);

    const worse = engineStatusRows({
      ...good,
      roll: null,
      pitch: -30.2,
      locked: true,
      previewMatches: false,
      pitchWarning: true,
      error: "context-lost",
    });
    const worseText = worse.map((r) => `${r.label}: ${r.value}`).join("\n");
    expect(worseText).toContain("좌우 — · 앞뒤 -30.2°");
    expect(worseText).toContain("촬영 중 · 보정값 고정");
    expect(worseText).toContain("미리보기와 사진이 다를 수 있어요");
    expect(worse.find((r) => r.label === "주의")).toBeDefined();
    expect(worse.find((r) => r.label === "마지막 오류")!.value).toBe("context-lost");
  });
});
