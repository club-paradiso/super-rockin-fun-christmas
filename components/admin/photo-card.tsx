"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { StaffPhotoView } from "@/lib/ops/admin";
import type { ModerationAction } from "@/lib/ops/moderation";
import { errorText, postJson } from "./api";
import { ConfirmDialog } from "./confirm-dialog";
import { ACTION_LABEL, STATUS_LABEL, STATUS_TONE, formatTime } from "./labels";
import { QrRecovery } from "./qr-recovery";

const ACTION_STYLE: Record<ModerationAction, string> = {
  approve: "admin-btn-approve",
  reject: "admin-btn-quiet",
  hide: "admin-btn-quiet",
  unhide: "admin-btn-approve",
  reopen: "admin-btn-quiet",
  delete: "admin-btn-danger",
};

/**
 * One photo with its allowed actions. Thumbnails come from the staff-only image proxy (small
 * review copy, never the full JPEG). Delete always goes through a confirmation dialog; hiding
 * from the wall asks first and can be undone for a few seconds (Figma A2, A3).
 */
const UNDO_HIDE_MS = 5_000;

export function PhotoCard({
  photo,
  showRecovery = false,
  primaryOnly = false,
}: {
  photo: StaffPhotoView;
  showRecovery?: boolean;
  /** Moderation queue: just approve / reject, as big as possible. */
  primaryOnly?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<ModerationAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmHide, setConfirmHide] = useState(false);
  const [undoHide, setUndoHide] = useState(false);
  const [shownNow, setShownNow] = useState(false);

  useEffect(() => {
    if (!undoHide) return;
    const timer = setTimeout(() => setUndoHide(false), UNDO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [undoHide]);

  const actions = primaryOnly
    ? photo.actions.filter((a) => a === "approve" || a === "reject")
    : photo.actions;

  async function run(action: ModerationAction) {
    setBusy(action);
    setError(null);
    const res = await postJson(`/api/admin/photos/${photo.id}/moderate`, {
      action,
      ...(action === "delete" ? { confirm: "DELETE" } : {}),
    });
    setBusy(null);
    setConfirmDelete(false);
    setConfirmHide(false);
    if (!res.ok) setError(errorText(res.error));
    setUndoHide(res.ok && action === "hide");
    router.refresh();
  }

  function ask(action: ModerationAction) {
    if (action === "delete") setConfirmDelete(true);
    else if (action === "hide") setConfirmHide(true);
    else void run(action);
  }

  async function showNow() {
    setError(null);
    const res = await postJson(`/api/admin/photos/${photo.id}/show-now`, {});
    if (res.ok) setShownNow(true);
    else setError(errorText(res.error));
  }

  return (
    <article
      className="admin-card flex flex-col overflow-hidden"
      data-testid="photo-card"
      data-photo-id={photo.id}
      data-status={photo.status}
      data-source={photo.source}
    >
      <div className="flex h-72 items-center justify-center bg-ink">
        {photo.deleted ? (
          <p className="text-lg text-mist">이미지 삭제됨</p>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- private staff-only proxy, no caching
          <img
            src={`/api/admin/photos/${photo.id}/image?variant=thumb`}
            alt={`${formatTime(photo.createdAt)} 촬영 사진`}
            loading="lazy"
            className="max-h-full w-auto"
          />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-3 py-1 text-sm font-bold ${STATUS_TONE[photo.status]}`}
            data-testid="photo-status"
          >
            {STATUS_LABEL[photo.status]}
          </span>
          <span
            className={`rounded-full px-3 py-1 text-sm font-bold ${
              photo.source === "mobile" ? "bg-ember text-ink" : "bg-cream/10"
            }`}
            data-testid="photo-source"
          >
            {photo.source === "mobile" ? "휴대폰 사진" : "현장 촬영"}
          </span>
          {photo.wallConsent && (
            <span className="rounded-full bg-cream/10 px-3 py-1 text-sm">미디어월 동의</span>
          )}
          {photo.wallEligible && (
            <span className="rounded-full bg-pine/40 px-3 py-1 text-sm">월 게시 가능</span>
          )}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-base text-mist">
          <dt>{photo.source === "mobile" ? "접수" : "촬영"}</dt>
          <dd className="text-cream">{formatTime(photo.createdAt)}</dd>
          <dt>프레임</dt>
          <dd className="text-cream">{photo.frameLabel}</dd>
          <dt>키오스크</dt>
          <dd className="text-cream">{photo.kioskLabel ?? "—"}</dd>
          <dt>세션</dt>
          <dd className="font-mono text-cream">{photo.sessionShort}</dd>
          <dt>링크</dt>
          <dd className="text-cream">
            {photo.source === "mobile"
              ? "없음 (방문객 휴대폰 사진)"
              : photo.linkActive
                ? `유효 (${formatTime(photo.tokenExpiresAt)}까지)`
                : "만료/삭제"}
          </dd>
        </dl>
        {error && (
          <p role="alert" className="text-base text-alert">
            {error}
          </p>
        )}
        <div className="mt-auto flex flex-wrap gap-2">
          {actions.map((a) => (
            <button
              key={a}
              type="button"
              disabled={busy !== null}
              onClick={() => ask(a)}
              className={`admin-btn ${ACTION_STYLE[a]} ${primaryOnly ? "flex-1 min-h-16 text-xl" : ""}`}
              data-testid={`action-${a}`}
            >
              {busy === a ? "…" : ACTION_LABEL[a]}
            </button>
          ))}
          {photo.wallEligible && !primaryOnly && (
            <button
              type="button"
              disabled={busy !== null || shownNow}
              onClick={showNow}
              className="admin-btn admin-btn-primary"
              data-testid="action-show-now"
            >
              {shownNow ? "곧 미디어월에 나와요" : "지금 띄우기"}
            </button>
          )}
        </div>
        {undoHide && (
          <div
            role="status"
            className="flex items-center justify-between gap-3 rounded-xl bg-ink p-3"
            data-testid="undo-hide"
          >
            <span className="text-base">{photo.sessionShort} 사진을 숨겼어요.</span>
            <button
              type="button"
              className="admin-btn admin-btn-quiet min-h-12"
              disabled={busy !== null}
              onClick={() => run("unhide")}
            >
              되돌리기
            </button>
          </div>
        )}
        {showRecovery && photo.canShowQrAgain && <QrRecovery photoId={photo.id} />}
      </div>
      <ConfirmDialog
        open={confirmHide}
        title={`${photo.sessionShort} 사진을 미디어월에서 숨길까요?`}
        confirmLabel="숨기기"
        danger
        busy={busy === "hide"}
        onConfirm={() => run("hide")}
        onCancel={() => setConfirmHide(false)}
      >
        이 사진만 바로 빠지고, 다른 사진은 그대로 돌아가요.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmDelete}
        title="사진을 삭제할까요?"
        confirmLabel="영구 삭제"
        danger
        busy={busy === "delete"}
        onConfirm={() => run("delete")}
        onCancel={() => setConfirmDelete(false)}
      >
        {photo.source === "mobile"
          ? "이미지가 즉시 지워지고 미디어월에도 다시 나오지 않아요. 되돌릴 수 없어요."
          : "이미지가 즉시 지워지고, 방문객의 QR 링크도 더 이상 열리지 않아요. 되돌릴 수 없어요."}
      </ConfirmDialog>
    </article>
  );
}
