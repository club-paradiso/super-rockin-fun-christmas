"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { HALF_LIFE_MINUTES, SHOW_SECONDS } from "@/lib/wall/themes";
import { errorText, postJson } from "./api";

const SECONDS = [8, 10, 14, 20, 30, 45, 60, 90, 120];
const HALF_LIVES = [0, 10, 20, 30, 60, 120, 180, 360];

const minutesText = (m: number) =>
  m < 60 ? `${m}분` : m % 60 === 0 ? `${m / 60}시간` : `${Math.floor(m / 60)}시간 ${m % 60}분`;

/**
 * How fast the wall turns over (D92): how long one photo stays up, and the half-life that lets
 * newer photos come up more often. One audited setting; every wall follows within one poll.
 * Neither changes which photos may be shown: that is moderation and consent only.
 */
export function WallPaceForm({
  showSeconds,
  halfLifeMinutes,
}: {
  showSeconds: number;
  halfLifeMinutes: number;
}) {
  const router = useRouter();
  const [seconds, setSeconds] = useState(showSeconds);
  const [halfLife, setHalfLife] = useState(halfLifeMinutes);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = seconds !== showSeconds || halfLife !== halfLifeMinutes;
  // A stored value that is not one of the presets still has to be selectable.
  const options = (presets: number[], current: number) =>
    [...new Set([...presets, current])].sort((a, b) => a - b);

  async function save(next: { showSeconds: number; halfLifeMinutes: number }) {
    setBusy(true);
    setMessage(null);
    const res = await postJson("/api/admin/settings", { wallPace: next });
    setBusy(false);
    setMessage(
      res.ok
        ? { ok: true, text: "저장했어요. 미디어월 화면은 5초 안에 따라와요." }
        : { ok: false, text: errorText(res.error) },
    );
    router.refresh();
  }

  function reset() {
    setSeconds(SHOW_SECONDS.default);
    setHalfLife(HALF_LIFE_MINUTES.default);
    void save({ showSeconds: SHOW_SECONDS.default, halfLifeMinutes: HALF_LIFE_MINUTES.default });
  }

  return (
    <section className="admin-card flex flex-col gap-4 p-4" data-testid="wall-pace">
      <div>
        <h2 className="text-2xl font-bold">미디어월 사진 속도</h2>
        <p className="mt-1 text-base text-ink/75">
          어떤 사진이 뜨는지는 바뀌지 않아요. 얼마나 오래, 얼마나 자주 뜨는지만 정해요.
        </p>
      </div>

      <div className="flex flex-col gap-2 rounded-2xl bg-backdrop p-3">
        <label className="flex flex-wrap items-center gap-3 text-lg">
          한 장이 떠 있는 시간
          <select
            value={seconds}
            onChange={(e) => setSeconds(Number(e.target.value))}
            className="admin-input"
            data-testid="wall-show-seconds"
          >
            {options(SECONDS, seconds).map((s) => (
              <option key={s} value={s}>
                {s}초{s === SHOW_SECONDS.default ? " (기본)" : ""}
              </option>
            ))}
          </select>
        </label>
        <p className="text-base text-ink/75">
          짧으면 사진이 빨리 바뀌고, 길면 한 장을 오래 볼 수 있어요.
        </p>
      </div>

      <div className="flex flex-col gap-2 rounded-2xl bg-backdrop p-3">
        <label className="flex flex-wrap items-center gap-3 text-lg">
          반감기
          <select
            value={halfLife}
            onChange={(e) => setHalfLife(Number(e.target.value))}
            className="admin-input"
            data-testid="wall-half-life"
          >
            {options(HALF_LIVES, halfLife).map((m) => (
              <option key={m} value={m}>
                {m === 0 ? "끔 (모든 사진 똑같이)" : minutesText(m)}
              </option>
            ))}
          </select>
        </label>
        <p className="text-base text-ink/75" data-testid="wall-half-life-note">
          {halfLife === 0
            ? "꺼져 있어요. 오래된 사진도 새 사진과 똑같은 횟수로 나와요."
            : `찍은 지 ${minutesText(halfLife)} 된 사진은 새 사진의 절반, ${minutesText(halfLife * 2)} 된 사진은 4분의 1만큼 나와요. 오래된 사진도 사라지지는 않아요.`}
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className="admin-btn admin-btn-primary"
          disabled={busy || !dirty}
          onClick={() => void save({ showSeconds: seconds, halfLifeMinutes: halfLife })}
          data-testid="wall-pace-save"
        >
          {busy ? "저장 중…" : "속도 저장"}
        </button>
        <button
          type="button"
          className="admin-btn admin-btn-quiet"
          disabled={busy}
          onClick={reset}
          data-testid="wall-pace-reset"
        >
          기본값으로 되돌리기
        </button>
      </div>
      {message && (
        <p
          role="status"
          className={`text-base ${message.ok ? "text-ink/75" : "text-danger"}`}
          data-testid="wall-pace-message"
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
