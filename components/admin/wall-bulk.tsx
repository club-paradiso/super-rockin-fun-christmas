"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { StaffPhotoView } from "@/lib/ops/admin";
import { errorText, postJson } from "./api";
import { ConfirmDialog } from "./confirm-dialog";
import { PhotoCard } from "./photo-card";

interface BulkAnswer {
  done: string[];
  failed: { id: string; reason: string }[];
}

/**
 * 「게시 중」: every photo the wall may show, ticked one by one or all at once, and taken down in
 * one go. Taking down is `hide` (can be undone); the last batch can be put back with one press.
 * Each card keeps its own buttons (숨기기, 지금 띄우기, 삭제) for one photo at a time.
 */
export function WallBulk({ photos, empty }: { photos: StaffPhotoView[]; empty: string }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastHidden, setLastHidden] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  // Ticks for photos that are no longer on this page (taken down elsewhere) do not count.
  const onPage = new Set(photos.map((p) => p.id));
  const chosen = [...selected].filter((id) => onPage.has(id));
  const allChosen = photos.length > 0 && chosen.length === photos.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function send(action: "hide" | "unhide", ids: string[]) {
    setBusy(true);
    setError(null);
    const res = await postJson<BulkAnswer>("/api/admin/photos/bulk", { action, ids });
    setBusy(false);
    setConfirm(false);
    if (!res.ok) {
      setError(errorText(res.error));
      return;
    }
    const { done, failed } = res.data;
    if (action === "hide") {
      setLastHidden(done);
      setSelected(new Set());
      setMessage(
        `${done.length}장을 미디어월에서 내렸어요.` +
          (failed.length ? ` ${failed.length}장은 이미 상태가 바뀌어 그대로예요.` : ""),
      );
    } else {
      setLastHidden([]);
      setMessage(`${done.length}장을 다시 미디어월에 올렸어요.`);
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        className="admin-card sticky top-2 z-20 flex flex-wrap items-center gap-2 p-3"
        data-testid="wall-bulk-bar"
      >
        <button
          type="button"
          className="admin-btn admin-btn-quiet"
          disabled={busy || photos.length === 0}
          onClick={() => setSelected(allChosen ? new Set() : new Set(photos.map((p) => p.id)))}
          data-testid="wall-select-all"
        >
          {allChosen ? "선택 해제" : `이 페이지 전체 선택 (${photos.length})`}
        </button>
        <span className="text-base text-ink/75" data-testid="wall-selected-count">
          {chosen.length}장 선택
        </span>
        <button
          type="button"
          className="admin-btn admin-btn-danger ml-auto"
          disabled={busy || chosen.length === 0}
          onClick={() => setConfirm(true)}
          data-testid="wall-hide-selected"
        >
          {busy ? "…" : `선택한 ${chosen.length}장 내리기`}
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
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-paper p-3 ring-1 ring-ink/20"
          data-testid="wall-bulk-result"
        >
          <span className="text-base">{message}</span>
          {lastHidden.length > 0 && (
            <button
              type="button"
              className="admin-btn admin-btn-quiet min-h-12"
              disabled={busy}
              onClick={() => send("unhide", lastHidden)}
              data-testid="wall-undo"
            >
              되돌리기
            </button>
          )}
        </div>
      )}
      {photos.length === 0 ? (
        <p className="admin-card p-8 text-center text-base text-ink/75" data-testid="queue-empty">
          {empty}
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="moderation-queue">
          {photos.map((p) => (
            <PhotoCard key={p.id} photo={p} selected={selected.has(p.id)} onSelect={toggle} />
          ))}
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title={`사진 ${chosen.length}장을 미디어월에서 내릴까요?`}
        confirmLabel="내리기"
        danger
        busy={busy}
        onConfirm={() => send("hide", chosen)}
        onCancel={() => setConfirm(false)}
      >
        바로 미디어월에서 빠지고 「숨김」으로 가요. 방문객의 QR 링크는 그대로예요. 「숨김」에서 다시
        보이게 할 수 있어요.
      </ConfirmDialog>
    </div>
  );
}
