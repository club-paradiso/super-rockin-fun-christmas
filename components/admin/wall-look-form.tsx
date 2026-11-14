"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ROTATE_MINUTES, type WallLook, type WallTheme } from "@/lib/wall/themes";
import { errorText, postJson } from "./api";

type ThemeCard = Pick<WallTheme, "id" | "name" | "note" | "preview" | "status">;

/**
 * Media-wall background (D85): pick the theme, or let the wall change by itself between the ones
 * ticked for rotation. One audited setting; every wall follows within one poll (about 5 s).
 * Changing it never touches photos, moderation or the booth.
 */
export function WallLookForm({
  look,
  themes,
  defaultTheme,
  activeTheme,
}: {
  look: WallLook;
  themes: ThemeCard[];
  defaultTheme: string;
  /** What the wall shows right now (differs from `look.theme` while rotating). */
  activeTheme: string;
}) {
  const router = useRouter();
  const [theme, setTheme] = useState(look.theme);
  const [rotate, setRotate] = useState(look.rotate);
  const [minutes, setMinutes] = useState(look.rotateMinutes);
  const [rotation, setRotation] = useState<string[]>(look.rotation);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const dirty =
    theme !== look.theme ||
    rotate !== look.rotate ||
    minutes !== look.rotateMinutes ||
    rotation.join() !== look.rotation.join();
  const rotationShort = rotate && rotation.length < 2;

  async function save(next: WallLook) {
    setBusy(true);
    setMessage(null);
    const res = await postJson("/api/admin/settings", { wallLook: next });
    setBusy(false);
    setMessage(
      res.ok
        ? { ok: true, text: "저장했어요. 미디어월 화면은 5초 안에 바뀌어요." }
        : { ok: false, text: errorText(res.error) },
    );
    router.refresh();
  }

  function reset() {
    setTheme(defaultTheme);
    setRotate(false);
    setMinutes(ROTATE_MINUTES.default);
    setRotation([]);
    void save({
      theme: defaultTheme,
      rotate: false,
      rotateMinutes: ROTATE_MINUTES.default,
      rotation: [],
    });
  }

  const toggleRotation = (id: string) =>
    setRotation((list) => (list.includes(id) ? list.filter((t) => t !== id) : [...list, id]));

  return (
    <section className="admin-card flex flex-col gap-4 p-4" data-testid="wall-look">
      <div>
        <h2 className="admin-h2">미디어월 배경</h2>
        <p className="mt-1 text-base text-ink/75">
          배경을 바꿔도 사진·검수·부스는 그대로예요. 지금 화면:{" "}
          <strong className="text-ink" data-testid="wall-look-active">
            {themes.find((t) => t.id === activeTheme)?.name ?? activeTheme}
          </strong>
        </p>
      </div>

      <ul
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
        role="radiogroup"
        aria-label="배경"
      >
        {themes.map((t) => {
          const selected = theme === t.id;
          return (
            <li
              key={t.id}
              className={`flex flex-col overflow-hidden rounded-xl border bg-backdrop ${
                selected ? "border-ink ring-1 ring-ink" : "border-ink/15"
              }`}
              data-testid="wall-theme"
              data-theme={t.id}
              data-selected={selected}
            >
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setTheme(t.id)}
                className="flex flex-col text-left active:bg-ink/10"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- bundled 640×180 preview */}
                <img
                  src={t.preview}
                  alt=""
                  width={640}
                  height={180}
                  loading="lazy"
                  className="aspect-[32/9] w-full object-cover"
                />
                <span className="flex flex-col gap-1 p-2.5">
                  <span className="text-[15px] leading-snug font-bold">
                    {selected && <span aria-hidden>✓ </span>}
                    {t.name}
                  </span>
                  <span className="admin-help">{t.note}</span>
                  {(t.id === defaultTheme || t.status === "legacy") && (
                    <span className="admin-chip w-fit bg-ink/10 text-ink/75">
                      {t.id === defaultTheme && "기본 배경"}
                      {t.status === "legacy" && "이전 디자인"}
                    </span>
                  )}
                </span>
              </button>
              {rotate && (
                <label className="flex min-h-11 items-center gap-2 border-t border-ink/15 px-2.5 text-sm">
                  <input
                    type="checkbox"
                    className="h-6 w-6"
                    checked={rotation.includes(t.id)}
                    onChange={() => toggleRotation(t.id)}
                    data-testid={`wall-rotation-${t.id}`}
                  />
                  돌아가며 보여 주기
                </label>
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-3 rounded-xl bg-backdrop p-3">
        <label className="flex min-h-12 items-center gap-3 text-base">
          <input
            type="checkbox"
            className="h-6 w-6"
            checked={rotate}
            onChange={(e) => {
              setRotate(e.target.checked);
              // Start from the chosen theme, so ticking the box alone already makes sense.
              if (e.target.checked && rotation.length === 0) setRotation([theme]);
            }}
            data-testid="wall-rotate"
          />
          배경을 자동으로 바꿔요
        </label>
        {rotate && (
          <>
            <label className="flex flex-wrap items-center gap-3 text-base">
              바꾸는 간격
              <select
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                className="admin-input"
                data-testid="wall-rotate-minutes"
              >
                {[5, 10, 15, 20, 30, 45, 60, 90, 120].map((m) => (
                  <option key={m} value={m}>
                    {m}분
                  </option>
                ))}
              </select>
            </label>
            <p className="text-base text-ink/75">
              위에서 &ldquo;돌아가며 보여 주기&rdquo;를 켠 배경 {rotation.length}개가 차례로 나와요.
              {rotationShort && " 두 개 이상 골라 주세요."}
            </p>
          </>
        )}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          className="admin-btn admin-btn-primary"
          disabled={busy || !dirty || rotationShort}
          onClick={() => void save({ theme, rotate, rotateMinutes: minutes, rotation })}
          data-testid="wall-look-save"
        >
          {busy ? "저장 중…" : "배경 저장"}
        </button>
        <button
          type="button"
          className="admin-btn admin-btn-quiet"
          disabled={busy}
          onClick={reset}
          data-testid="wall-look-reset"
        >
          기본 배경으로 되돌리기
        </button>
      </div>
      {message && (
        <p
          role="status"
          className={`text-base ${message.ok ? "text-ink/75" : "text-danger"}`}
          data-testid="wall-look-message"
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
