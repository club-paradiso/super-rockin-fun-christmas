"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { EventSettings } from "@/lib/storage/types";
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

/** Big, explicit on/off switches. Every change is audited server-side. */
export function EmergencyPanel({ settings }: { settings: EventSettings }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
              className={`flex min-h-28 flex-col items-start gap-1 rounded-2xl border-2 p-4 text-left transition ${
                on ? "border-alert bg-alert/20" : "border-cream/15 bg-ink"
              }`}
            >
              <span className="flex w-full items-center justify-between text-xl font-bold">
                {s.title}
                <span
                  className={`rounded-full px-3 py-1 text-sm ${on ? "bg-alert text-ink" : "bg-dusk text-mist"}`}
                >
                  {busy === s.key ? "…" : on ? "켜짐" : "꺼짐"}
                </span>
              </span>
              <span className="text-base text-mist">{s.help}</span>
            </button>
          );
        })}
      </div>
      {error && <p className="mt-3 text-alert">{error}</p>}
    </section>
  );
}
