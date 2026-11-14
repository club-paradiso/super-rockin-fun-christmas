"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { EventSettings, WallForce } from "@/lib/storage/types";
import type { WallOpenReason } from "@/lib/wall/hours";
import { errorText, postJson } from "./api";

const SWITCHES = [
  {
    key: "pauseSubmissions",
    title: "미디어월 게시 신청 중지",
    help: "새 사진의 미디어월 게시 신청만 막아요. 촬영과 QR 저장은 그대로 돼요.",
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
  { value: "auto", label: "자동" },
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
      className="admin-card overflow-hidden"
      aria-labelledby="emergency-title"
      data-testid="emergency-panel"
    >
      <h2 id="emergency-title" className="admin-h2 px-4 pt-4 pb-3">
        긴급 제어
      </h2>
      {/* One list, one hairline between rows: no card inside a card. A row that is ON is tinted. */}
      <div className="divide-y divide-ink/10 border-t border-ink/10 md:grid md:grid-cols-3 md:divide-x md:divide-y-0">
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
              className={`admin-switch-row md:items-start ${on ? "bg-danger/[.07]" : ""}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold">{s.title}</span>
                <span className="admin-help mt-0.5 block">{s.help}</span>
              </span>
              <span className="flex shrink-0 flex-col items-center gap-1">
                <span className="admin-switch-track" data-on={on} aria-hidden />
                <span
                  className={`text-[13px] leading-none font-semibold ${on ? "text-danger" : "text-ink/75"}`}
                >
                  {busy === s.key ? "…" : on ? "켜짐" : "꺼짐"}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-3 border-t border-ink/10 p-4" data-testid="wall-force">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-base font-semibold">미디어월 켜기/끄기</h3>
          <p
            className="flex items-center gap-1.5 text-sm font-semibold"
            data-testid="wall-open-status"
          >
            <span
              aria-hidden
              className={`size-2 shrink-0 rounded-full ${wallStatus.open ? "bg-approve" : "bg-danger"}`}
            />
            지금 {OPEN_TEXT[wallStatus.reason]}
          </p>
        </div>
        <div className="admin-seg" role="radiogroup" aria-label="미디어월 켜기/끄기">
          {FORCE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={settings.wallForce === o.value}
              disabled={busy !== null}
              onClick={() => setForce(o.value)}
              data-testid={`wall-force-${o.value}`}
              className="admin-seg-btn"
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="admin-help">
          자동은 설정한 운영 시간에만 사진이 나와요. 시간 밖에는 &ldquo;오늘의 미디어월은
          여기까지예요&rdquo; 화면이 떠요.
        </p>
      </div>
      {error && <p className="px-4 pb-4 text-danger">{error}</p>}
    </section>
  );
}
