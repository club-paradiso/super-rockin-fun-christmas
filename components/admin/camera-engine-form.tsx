"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CAMERA_ENGINE, CAMERA_PROFILES } from "@/config/camera-engine";
import {
  sameCameraEngine,
  type CameraEngineMode,
  type CameraEngineSettings,
} from "@/lib/camera-engine/settings";
import { errorText, postJson } from "./api";
import { ConfirmDialog } from "./confirm-dialog";

const MODES: { value: CameraEngineMode; label: string; help: string }[] = [
  { value: "off", label: "끄기", help: "보정하지 않아요. 사진은 지금까지와 똑같이 찍혀요." },
  {
    value: "auto",
    label: "자동",
    help: "태블릿 센서로 기울기를 재서 알아서 보정해요. 따로 맞출 것이 없어요.",
  },
  {
    value: "manual",
    label: "수동",
    help: "센서를 쓰지 않고 아래에 적은 기울기만큼 보정해요. 자동이 안 될 때만 쓰세요.",
  },
];

const SWITCHES: {
  key: "level" | "perspective" | "portraitGuard";
  title: string;
  help: string;
}[] = [
  {
    key: "level",
    title: "좌우 기울기 보정",
    help: "키오스크가 옆으로 기울어 있어도 사진의 수평을 맞춰요.",
  },
  {
    key: "perspective",
    title: "앞뒤 기울기 보정",
    help: "키오스크가 뒤로 젖혀지거나 앞으로 숙여져 있을 때 위아래가 찌그러져 보이는 것을 줄여요.",
  },
  {
    key: "portraitGuard",
    title: "사람 왜곡 방지",
    help: "얼굴이나 몸이 늘어나 보일 만큼은 보정하지 않아요. 켜 두는 것을 권해요.",
  },
];

const { limits } = CAMERA_ENGINE;

/** A number field keeps what was typed, so "-" and "2." can be on the way to a number. */
function parseDegrees(text: string, max: number): number | null {
  const t = text.trim();
  if (t === "") return 0;
  const v = Number(t);
  return Number.isFinite(v) && Math.abs(v) <= max ? v : null;
}

function parseFov(text: string): number | null | "bad" {
  const t = text.trim();
  if (t === "") return null;
  const v = Number(t);
  return Number.isFinite(v) && v >= limits.fovMinDeg && v <= limits.fovMaxDeg ? v : "bad";
}

/**
 * 「카메라 자동 보정」 (Intelligent Camera Engine, lib/camera-engine): the one staff setting. Saved
 * whole through the audited settings API; each booth takes it up at its next guest, never under
 * one. What a booth is doing with it is on the kiosks page, from that booth's heartbeat.
 */
export function CameraEngineForm({ settings }: { settings: CameraEngineSettings }) {
  const router = useRouter();
  const [draft, setDraft] = useState(settings);
  const [rollText, setRollText] = useState(String(settings.rollOffset));
  const [pitchText, setPitchText] = useState(String(settings.pitchOffset));
  const [fovText, setFovText] = useState(settings.fov === null ? "" : String(settings.fov));
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const roll = parseDegrees(rollText, limits.rollOffsetDeg);
  const pitch = parseDegrees(pitchText, limits.pitchOffsetDeg);
  const fov = parseFov(fovText);
  const valid = roll !== null && pitch !== null && fov !== "bad";
  const next: CameraEngineSettings | null = valid
    ? { ...draft, rollOffset: roll, pitchOffset: pitch, fov }
    : null;
  const dirty = next !== null && !sameCameraEngine(next, settings);
  const off = draft.mode === "off";

  async function save(value: CameraEngineSettings, done: string) {
    setBusy(true);
    setMessage(null);
    const res = await postJson("/api/admin/settings", { cameraEngine: value });
    setBusy(false);
    setConfirmReset(false);
    if (res.ok) {
      setDraft(value);
      setRollText(String(value.rollOffset));
      setPitchText(String(value.pitchOffset));
      setFovText(value.fov === null ? "" : String(value.fov));
    }
    setMessage(res.ok ? { ok: true, text: done } : { ok: false, text: errorText(res.error) });
    router.refresh();
  }

  return (
    <section className="admin-card flex flex-col" data-testid="camera-engine-form">
      <div className="flex flex-col gap-3 p-4">
        <h2 className="admin-h2">카메라 자동 보정</h2>
        <p className="admin-help">
          키오스크가 비스듬하게 놓여 있어도 사진이 기울거나 찌그러져 보이지 않게 해요. 처음에는 꺼져
          있어요. 실제 태블릿에서 시험 사진을 찍어 본 뒤에 켜세요.
        </p>
        <div className="admin-seg" role="radiogroup" aria-label="카메라 자동 보정 방식">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={draft.mode === m.value}
              disabled={busy}
              onClick={() => setDraft({ ...draft, mode: m.value })}
              data-testid={`camera-engine-mode-${m.value}`}
              className="admin-seg-btn"
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="admin-help" data-testid="camera-engine-mode-help">
          {MODES.find((m) => m.value === draft.mode)!.help}
        </p>
      </div>

      <div className="divide-y divide-ink/10 border-t border-ink/10">
        {SWITCHES.map((s) => {
          const on = draft[s.key];
          return (
            <button
              key={s.key}
              type="button"
              role="switch"
              aria-checked={on}
              disabled={busy || off}
              onClick={() => setDraft({ ...draft, [s.key]: !on })}
              data-testid={`camera-engine-${s.key}`}
              className="admin-switch-row"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold">{s.title}</span>
                <span className="admin-help mt-0.5 block">{s.help}</span>
              </span>
              <span className="flex shrink-0 flex-col items-center gap-1">
                <span className="admin-switch-track" data-on={on} aria-hidden />
                <span className="text-[13px] leading-none font-semibold text-ink/75">
                  {on ? "켜짐" : "꺼짐"}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-3 border-t border-ink/10 p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-base font-semibold">
            좌우 보정값(°)
            <input
              type="number"
              inputMode="decimal"
              step={0.1}
              min={-limits.rollOffsetDeg}
              max={limits.rollOffsetDeg}
              value={rollText}
              disabled={busy || off}
              onChange={(e) => setRollText(e.target.value)}
              aria-invalid={roll === null}
              className="admin-input font-normal"
              data-testid="camera-engine-roll"
            />
            <span className="admin-help font-normal">
              -{limits.rollOffsetDeg} ~ {limits.rollOffsetDeg}. 화면을 마주 보고 시계 방향으로
              기울었으면 +
            </span>
          </label>
          <label className="flex flex-col gap-1 text-base font-semibold">
            앞뒤 보정값(°)
            <input
              type="number"
              inputMode="decimal"
              step={0.1}
              min={-limits.pitchOffsetDeg}
              max={limits.pitchOffsetDeg}
              value={pitchText}
              disabled={busy || off}
              onChange={(e) => setPitchText(e.target.value)}
              aria-invalid={pitch === null}
              className="admin-input font-normal"
              data-testid="camera-engine-pitch"
            />
            <span className="admin-help font-normal">
              -{limits.pitchOffsetDeg} ~ {limits.pitchOffsetDeg}. 뒤로 젖혀져 화면이 위를 보면 +
            </span>
          </label>
        </div>
        <p className="admin-help" data-testid="camera-engine-offset-help">
          {draft.mode === "manual"
            ? "수동에서는 이 값이 곧 키오스크의 기울기예요. 센서는 쓰지 않아요."
            : "자동에서는 센서가 잰 기울기에 이 값을 더해요. 보통은 0으로 두세요."}
        </p>

        <details className="rounded-[10px] border border-ink/15 p-3">
          <summary className="cursor-pointer text-base font-semibold">고급</summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-base font-semibold">
              카메라 종류
              <select
                value={draft.profile}
                disabled={busy || off}
                onChange={(e) => setDraft({ ...draft, profile: e.target.value })}
                className="admin-input font-normal"
                data-testid="camera-engine-profile"
              >
                {CAMERA_PROFILES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-base font-semibold">
              카메라 화각(°)
              <input
                type="number"
                inputMode="decimal"
                step={0.5}
                min={limits.fovMinDeg}
                max={limits.fovMaxDeg}
                value={fovText}
                placeholder="비워 두면 카메라 종류의 값"
                disabled={busy || off}
                onChange={(e) => setFovText(e.target.value)}
                aria-invalid={fov === "bad"}
                className="admin-input font-normal"
                data-testid="camera-engine-fov"
              />
              <span className="admin-help font-normal">
                {limits.fovMinDeg} ~ {limits.fovMaxDeg}. 직접 잰 값이 있을 때만 적으세요. 모르면
                비워 두세요.
              </span>
            </label>
          </div>
        </details>

        {!valid && (
          <p className="text-base text-danger" data-testid="camera-engine-invalid">
            숫자가 범위를 벗어났어요. 칸 아래에 적힌 범위 안에서 적어 주세요.
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className="admin-btn admin-btn-primary"
            disabled={busy || !dirty}
            onClick={() =>
              next && void save(next, "저장했어요. 각 키오스크는 다음 손님부터 바뀌어요.")
            }
            data-testid="camera-engine-save"
          >
            {busy ? "저장 중…" : "저장"}
          </button>
          <button
            type="button"
            className="admin-btn admin-btn-quiet"
            disabled={busy}
            onClick={() => setConfirmReset(true)}
            data-testid="camera-engine-reset"
          >
            보정값 초기화
          </button>
        </div>
        {message && (
          <p
            role="status"
            className={`text-base ${message.ok ? "text-ink/75" : "text-danger"}`}
            data-testid="camera-engine-message"
          >
            {message.text}
          </p>
        )}
        <p className="admin-help">
          바꾼 내용은 각 키오스크에 다음 손님부터 들어가요. 촬영 중인 손님의 사진은 바뀌지 않아요.
          키오스크마다 지금 어떻게 보정하고 있는지는{" "}
          <Link href="/admin/kiosks" className="font-semibold text-ink underline">
            키오스크
          </Link>{" "}
          화면에서 볼 수 있어요.
        </p>
      </div>

      <ConfirmDialog
        open={confirmReset}
        title="보정값을 초기화할까요?"
        confirmLabel="초기화"
        busy={busy}
        onConfirm={() =>
          void save(
            {
              ...settings,
              rollOffset: 0,
              pitchOffset: 0,
              calibration: settings.calibration + 1,
            },
            "초기화했어요. 각 키오스크는 다음 손님부터 기울기를 처음부터 다시 재요.",
          )
        }
        onCancel={() => setConfirmReset(false)}
      >
        <p>
          좌우·앞뒤 보정값을 0으로 되돌리고, 각 키오스크가 기울기를 처음부터 다시 재게 해요. 켜기·
          끄기 같은 다른 설정은 그대로예요.
        </p>
      </ConfirmDialog>
    </section>
  );
}
