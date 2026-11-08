"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { KioskMode } from "@/lib/storage/types";
import { errorText, postJson } from "./api";

const OPTIONS: { mode: KioskMode; label: string; hint: string }[] = [
  { mode: "standard", label: "기본 화면", hint: "Figma 디자인 그대로" },
  { mode: "easy", label: "쉬운 화면", hint: "큰 글씨 · 높은 대비 · 선택지 줄임 · 긴 카운트다운" },
];

/**
 * Booth start mode for each new guest (D67). Guests can still switch on every screen; this only
 * decides how the booth greets the next person. Audited like every setting.
 */
export function KioskModeForm({ mode }: { mode: KioskMode }) {
  const router = useRouter();
  const [busy, setBusy] = useState<KioskMode | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function choose(next: KioskMode) {
    if (next === mode) return;
    setBusy(next);
    setMessage(null);
    const res = await postJson("/api/admin/settings", { kioskDefaultMode: next });
    setBusy(null);
    setMessage(res.ok ? "저장했어요. 다음 방문객부터 적용돼요 (최대 1분)." : errorText(res.error));
    router.refresh();
  }

  return (
    <section className="admin-card flex flex-col gap-3 p-4" data-testid="kiosk-mode">
      <h2 className="text-2xl font-bold">부스 시작 화면</h2>
      <p className="text-base text-mist">
        방문객은 어느 화면에서든 직접 바꿀 수 있어요. 여기서는 처음 보이는 화면만 정해요.
      </p>
      <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="부스 시작 화면">
        {OPTIONS.map((o) => (
          <button
            key={o.mode}
            type="button"
            role="radio"
            aria-checked={mode === o.mode}
            disabled={busy !== null}
            onClick={() => void choose(o.mode)}
            data-testid={`kiosk-mode-${o.mode}`}
            className={`admin-btn flex-col items-start py-2 ${
              mode === o.mode ? "admin-btn-primary" : "admin-btn-quiet"
            }`}
          >
            <span>{busy === o.mode ? "…" : o.label}</span>
            <span className="text-sm font-normal opacity-80">{o.hint}</span>
          </button>
        ))}
      </div>
      {message && (
        <p role="status" className="text-base text-mist">
          {message}
        </p>
      )}
    </section>
  );
}
