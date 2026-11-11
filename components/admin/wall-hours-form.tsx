"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { WallHours } from "@/lib/storage/types";
import { errorText, postJson } from "./api";

/** Daily opening hours of the media wall (event time zone). Audited like every setting. */
export function WallHoursForm({ hours, timeZone }: { hours: WallHours | null; timeZone: string }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(!!hours);
  const [start, setStart] = useState(hours?.start ?? "17:00");
  const [end, setEnd] = useState(hours?.end ?? "22:00");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setMessage(null);
    const res = await postJson("/api/admin/settings", {
      wallHours: enabled ? { start, end } : null,
    });
    setBusy(false);
    setMessage(res.ok ? "저장했어요." : errorText(res.error));
    router.refresh();
  }

  return (
    <section className="admin-card flex flex-col gap-3 p-4" data-testid="wall-hours">
      <h2 className="text-2xl font-bold">미디어월 운영 시간</h2>
      <label className="flex items-center gap-3 text-lg">
        <input
          type="checkbox"
          className="h-6 w-6"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          data-testid="wall-hours-enabled"
        />
        운영 시간을 정해요 (끄면 언제나 켜져 있어요)
      </label>
      {enabled && (
        <div className="flex flex-wrap items-center gap-3 text-lg">
          <label className="flex items-center gap-2">
            시작
            <input
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="rounded-lg bg-backdrop px-3 py-2 text-ink"
              data-testid="wall-hours-start"
            />
          </label>
          <label className="flex items-center gap-2">
            끝
            <input
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="rounded-lg bg-backdrop px-3 py-2 text-ink"
              data-testid="wall-hours-end"
            />
          </label>
        </div>
      )}
      <p className="text-base text-ink/75">
        시간대: {timeZone}. 끝이 시작보다 이르면 자정을 넘겨요(예: 18:00~01:00). 관리자 첫 화면의
        &ldquo;계속 켜기&rdquo;/&ldquo;끄기&rdquo;가 이 시간보다 먼저예요.
      </p>
      <div>
        <button
          type="button"
          className="admin-btn-primary"
          disabled={busy}
          onClick={save}
          data-testid="wall-hours-save"
        >
          {busy ? "저장 중…" : "저장"}
        </button>
      </div>
      {message && (
        <p role="status" className="text-base" data-testid="wall-hours-message">
          {message}
        </p>
      )}
    </section>
  );
}
