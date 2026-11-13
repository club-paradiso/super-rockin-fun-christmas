"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "./confirm-dialog";
import { errorText, postJson } from "./api";

/**
 * Public media wall (D86). The wall address opens for anyone, with no enrollment. This switch
 * decides whether that anonymous audience is sent photos, and it changes what the booth tells
 * guests: on = the consent screen says the wall is also shown at its web address, and consent
 * given from then on covers it. Photos consented before, or while it was off, stay venue-only.
 */
export function PublicWallForm({
  enabled,
  wallUrl,
  publicCount,
  venueOnlyCount,
}: {
  enabled: boolean;
  /** The dedicated wall address, when one is configured (WALL_HOSTS). */
  wallUrl: string | null;
  /** Photos on the wall right now that the public audience may see / may not see. */
  publicCount: number;
  venueOnlyCount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function set(next: boolean) {
    setBusy(true);
    setMessage(null);
    const res = await postJson("/api/admin/settings", { wallPublic: next });
    setBusy(false);
    setConfirming(false);
    setMessage(
      res.ok
        ? next
          ? "켰어요. 부스 안내 문구는 1분 안에 바뀌고, 그 뒤 동의한 사진부터 공개 화면에 보여요."
          : "껐어요. 주소로 들어온 화면에는 이제 사진이 나오지 않아요."
        : errorText(res.error),
    );
    router.refresh();
  }

  return (
    <section className="admin-card flex flex-col gap-3 p-4" data-testid="public-wall">
      <h2 className="text-2xl font-bold">공개 미디어월</h2>
      <p className="text-base text-ink/75">
        미디어월 주소{wallUrl ? <> ({wallUrl})</> : ""}는 기기 등록 없이 누구나 열 수 있어요. 이
        스위치는 그렇게 들어온 화면에 <strong className="text-ink">사진을 보여 줄지</strong>를
        정해요.
      </p>
      <p className="text-lg" data-testid="public-wall-state">
        지금:{" "}
        <strong>{enabled ? "켜짐 · 주소로 들어오면 사진이 보여요" : "꺼짐 · 배경만 보여요"}</strong>
      </p>
      <ul className="list-disc pl-5 text-base text-ink/75">
        <li>
          켜면 부스 동의 화면에 &ldquo;온라인 주소에서도 보여요&rdquo; 안내가 붙고, 그 안내를 보고
          동의한 사진만 공개 화면에 나와요.
        </li>
        <li>
          그 전에 찍은 사진은 현장 화면 동의만 받은 것이라 공개 화면에는 나오지 않아요 (등록한 현장
          화면에는 그대로 나와요).
        </li>
        <li>
          지금 미디어월 사진: 공개 화면에도 보이는 사진 <strong>{publicCount}</strong>장 · 현장
          화면에만 보이는 사진 <strong>{venueOnlyCount}</strong>장
        </li>
      </ul>
      <div>
        <button
          type="button"
          className={`admin-btn ${enabled ? "admin-btn-quiet" : "admin-btn-primary"}`}
          disabled={busy}
          onClick={() => (enabled ? void set(false) : setConfirming(true))}
          data-testid="public-wall-toggle"
        >
          {busy ? "…" : enabled ? "공개 미디어월 끄기" : "공개 미디어월 켜기"}
        </button>
      </div>
      {message && (
        <p role="status" className="text-base text-ink/75" data-testid="public-wall-message">
          {message}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        title="공개 미디어월을 켤까요?"
        confirmLabel="켜기"
        busy={busy}
        onConfirm={() => void set(true)}
        onCancel={() => setConfirming(false)}
      >
        <p>
          주소를 아는 사람은 누구나, 행사장 밖에서도 승인된 사진을 볼 수 있게 돼요. 부스 동의 화면에
          그 안내가 붙어요.
        </p>
      </ConfirmDialog>
    </section>
  );
}
