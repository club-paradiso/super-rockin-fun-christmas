"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { StaffPhotoView } from "@/lib/ops/admin";
import { BULK_HIDE_MAX } from "@/lib/ops/moderation";
import { errorText, postJson } from "./api";
import { ConfirmDialog } from "./confirm-dialog";
import { PhotoCard } from "./photo-card";

/**
 * Everything the media wall may show right now, newest first, one page at a time. Staff tick the
 * photos to take down (or the whole page) and hide them in one go. Hiding is the reversible move:
 * the result bar offers "되돌리기" for exactly the photos this tap hid, and each one is also back
 * under 「숨김」 with its own "다시 보이기".
 */
export function OnWallBoard({
  photos,
  total,
  nextBefore,
  isFirstPage,
}: {
  photos: StaffPhotoView[];
  /** All photos the wall may show right now (not only this page). */
  total: number;
  /** `before` for the next page, or null on the last page. */
  nextBefore: string | null;
  isFirstPage: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastHidden, setLastHidden] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const pageIds = useMemo(() => photos.map((p) => p.id), [photos]);
  // A photo that left the list (hidden elsewhere, refreshed away) is no longer selectable.
  const chosen = pageIds.filter((id) => selected.has(id));
  const allChosen = chosen.length === pageIds.length && pageIds.length > 0;

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function hide() {
    setBusy(true);
    setError(null);
    setMessage(null);
    const res = await postJson<{ hidden: string[]; skipped: string[] }>(
      "/api/admin/photos/bulk-hide",
      { ids: chosen.slice(0, BULK_HIDE_MAX) },
    );
    setBusy(false);
    setConfirm(false);
    if (!res.ok) {
      setError(errorText(res.error));
      return;
    }
    const { hidden, skipped } = res.data;
    setLastHidden(hidden);
    setSelected(new Set());
    setMessage(
      `${hidden.length}장을 미디어월에서 내렸어요.` +
        (skipped.length ? ` ${skipped.length}장은 이미 다른 상태라 건너뛰었어요.` : ""),
    );
    router.refresh();
  }

  async function undo() {
    setBusy(true);
    setError(null);
    let back = 0;
    for (const id of lastHidden) {
      const res = await postJson(`/api/admin/photos/${id}/moderate`, { action: "unhide" });
      if (res.ok) back++;
    }
    setBusy(false);
    setLastHidden([]);
    setMessage(`${back}장을 미디어월에 다시 올렸어요.`);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="admin-card flex flex-col gap-3 p-4" data-testid="on-wall-bar">
        <p className="text-lg font-semibold" data-testid="on-wall-total">
          지금 미디어월에 올라갈 수 있는 사진 {total}장
          <span className="ml-2 text-base font-normal text-ink/75">
            (이 화면 {photos.length}장 · 최신순)
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="admin-btn admin-btn-quiet"
            disabled={busy || pageIds.length === 0}
            onClick={() => setSelected(allChosen ? new Set() : new Set(pageIds))}
            data-testid="select-all"
          >
            {allChosen ? "선택 모두 해제" : `이 화면 ${pageIds.length}장 모두 선택`}
          </button>
          <button
            type="button"
            className="admin-btn admin-btn-danger flex-1"
            disabled={busy || chosen.length === 0}
            onClick={() => setConfirm(true)}
            data-testid="bulk-hide"
          >
            {chosen.length === 0
              ? "내릴 사진을 선택하세요"
              : `선택한 ${chosen.length}장 미디어월에서 내리기`}
          </button>
        </div>
        {error && (
          <p role="alert" className="text-base text-danger">
            {error}
          </p>
        )}
        {message && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-backdrop p-3"
            data-testid="bulk-result"
          >
            <span className="text-base">{message}</span>
            {lastHidden.length > 0 && (
              <button
                type="button"
                className="admin-btn admin-btn-quiet min-h-12"
                disabled={busy}
                onClick={undo}
                data-testid="bulk-undo"
              >
                {busy ? "…" : "되돌리기"}
              </button>
            )}
          </div>
        )}
      </div>

      {photos.length === 0 ? (
        <p className="admin-card p-8 text-center text-base text-ink/75" data-testid="queue-empty">
          미디어월에 올라간 사진이 없어요.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="moderation-queue">
          {photos.map((p) => (
            <PhotoCard
              key={p.id}
              photo={p}
              select={{ checked: selected.has(p.id), onChange: (on) => toggle(p.id, on) }}
            />
          ))}
        </div>
      )}

      <nav className="flex flex-wrap gap-2" aria-label="페이지">
        {!isFirstPage && (
          <Link href="/admin/moderation?view=on-wall" className="admin-btn admin-btn-quiet">
            처음(최신)으로
          </Link>
        )}
        {nextBefore && (
          <Link
            href={`/admin/moderation?view=on-wall&before=${encodeURIComponent(nextBefore)}`}
            className="admin-btn admin-btn-primary flex-1"
            data-testid="on-wall-next"
          >
            더 이전 사진 보기
          </Link>
        )}
      </nav>

      {chosen.length > 0 && (
        <>
          {/* Room so the pinned bar never covers the last card. */}
          <div className="h-24" aria-hidden />
          <div
            className="fixed inset-x-0 bottom-0 z-20 border-t border-ink/15 bg-backdrop/95 p-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur"
            data-testid="bulk-bar"
          >
            <div className="mx-auto flex max-w-6xl gap-2">
              <button
                type="button"
                className="admin-btn admin-btn-quiet"
                disabled={busy}
                onClick={() => setSelected(new Set())}
              >
                선택 해제
              </button>
              <button
                type="button"
                className="admin-btn admin-btn-danger flex-1"
                disabled={busy}
                onClick={() => setConfirm(true)}
                data-testid="bulk-hide-pinned"
              >
                선택한 {chosen.length}장 내리기
              </button>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirm}
        title={`선택한 ${chosen.length}장을 미디어월에서 내릴까요?`}
        confirmLabel="내리기"
        danger
        busy={busy}
        onConfirm={hide}
        onCancel={() => setConfirm(false)}
      >
        사진은 지워지지 않고 「숨김」으로 옮겨져요. 방문객의 QR 링크도 그대로예요. 바로 되돌릴 수
        있어요.
      </ConfirmDialog>
    </div>
  );
}
