"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { EventSettings, WallForce } from "@/lib/storage/types";
import type { WallOpenReason } from "@/lib/wall/hours";
import { errorText, postJson } from "./api";

const SWITCHES = [
  {
    key: "pauseSubmissions",
    title: "미디어월 참여 중지",
    help: "새 사진의 미디어월 신청만 막아요. 촬영과 QR 저장은 그대로 돼요.",
  },
  {
    key: "pauseWall",
    title: "미디어월 일시정지",
    help: "미디어월에서 사진을 모두 내리고 배경만 보여줘요. 다시 켜면 승인된 사진이 돌아와요.",
  },
  {
    key: "showHoldingScreen",
    title: "대기 화면 표시",
    help: "미디어월을 안내용 대기 화면으로 바꿔요. 사진은 보내지 않아요.",
  },
] as const;

const FORCE_OPTIONS: { value: WallForce; label: string }[] = [
  { value: "auto", label: "자동 (운영 시간)" },
  { value: "on", label: "계속 켜기" },
  { value: "off", label: "끄기" },
];

const OPEN_TEXT: Record<WallOpenReason, string> = {
  "forced-on": "켜짐 · 스태프가 켜 둠",
  "forced-off": "꺼짐 · 스태프가 꺼 둠",
  always: "켜짐 · 운영 시간 없음",
  "in-hours": "켜짐 · 운영 시간 안",
  "out-of-hours": "꺼짐 · 운영 시간 밖",
};

/**
 * Big, explicit on/off switches. Every change is audited server-side. `wallStatus` is computed
 * on the server (opening hours are in the event's time zone, not the phone's).
 */
export function EmergencyPanel({
  settings,
  wallStatus,
}: {
  settings: EventSettings;
  wallStatus: { open: boolean; reason: WallOpenReason };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setForce(wallForce: WallForce) {
    setBusy("wallForce");
    setError(null);
    const res = await postJson("/api/admin/settings", { wallForce });
    setBusy(null);
    if (!res.ok) setError(errorText(res.error));
    router.refresh();
  }

  async function toggle(key: (typeof SWITCHES)[number]["key"]) {
    setBusy(key);
    setError(null);
    const res = await postJson("/api/admin/settings", { [key]: !settings[key] });
    setBusy(null);
    if (!res.ok) setError(errorText(res.error));
    router.refresh();
  }

  return (
    <section
      className="admin-card p-4"
      aria-labelledby="emergency-title"
      data-testid="emergency-panel"
    >
      <h2 id="emergency-title" className="mb-3 text-2xl font-bold">
        긴급 제어
      </h2>
      <div className="grid gap-3 md:grid-cols-3">
        {SWITCHES.map((s) => {
          const on = settings[s.key];
          return (
            <button
              key={s.key}
              type="button"
              role="switch"
              aria-checked={on}
              disabled={busy !== null}
              onClick={() => toggle(s.key)}
              data-testid={`switch-${s.key}`}
              className={`flex min-h-28 flex-col items-start gap-1 rounded-3xl border-2 p-4 text-left transition ${
                on ? "border-danger bg-danger/10" : "border-ink/20 bg-backdrop"
              }`}
            >
              <span className="flex w-full items-center justify-between text-xl font-bold">
                {s.title}
                <span
                  className={`rounded-full px-3 py-1 text-sm ${on ? "bg-danger text-button-text" : "bg-ink/10 text-ink/75"}`}
                >
                  {busy === s.key ? "…" : on ? "켜짐" : "꺼짐"}
                </span>
              </span>
              <span className="text-base text-ink/75">{s.help}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex flex-col gap-2" data-testid="wall-force">
        <p className="text-xl font-bold">
          미디어월 켜기/끄기{" "}
          <span
            className={`ml-2 rounded-full px-3 py-1 text-sm ${wallStatus.open ? "bg-approve text-button-text" : "bg-danger text-button-text"}`}
            data-testid="wall-open-status"
          >
            지금 {OPEN_TEXT[wallStatus.reason]}
          </span>
        </p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="미디어월 켜기/끄기">
          {FORCE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={settings.wallForce === o.value}
              disabled={busy !== null}
              onClick={() => setForce(o.value)}
              data-testid={`wall-force-${o.value}`}
              className={`min-h-14 rounded-full border-2 px-4 text-lg font-bold ${
                settings.wallForce === o.value
                  ? "border-accent bg-accent/15"
                  : "border-ink/20 bg-backdrop"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="text-base text-ink/75">
          자동이면 설정의 운영 시간에만 사진이 나와요. 시간 밖에는 &ldquo;오늘의 미디어월은
          여기까지예요&rdquo; 화면이 떠요.
        </p>
      </div>
      {error && <p className="mt-3 text-danger">{error}</p>}
    </section>
  );
}
