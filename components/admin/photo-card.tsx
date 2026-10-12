"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
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
 * review copy, never the full JPEG). Delete always goes through a confirmation dialog.
 */
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
  const [shownNow, setShownNow] = useState(false);

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
    if (!res.ok) setError(errorText(res.error));
    router.refresh();
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
          {photo.wallConsent && (
            <span className="rounded-full bg-cream/10 px-3 py-1 text-sm">미디어월 동의</span>
          )}
          {photo.wallEligible && (
            <span className="rounded-full bg-pine/40 px-3 py-1 text-sm">월 게시 가능</span>
          )}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-base text-mist">
          <dt>촬영</dt>
          <dd className="text-cream">{formatTime(photo.createdAt)}</dd>
          <dt>프레임</dt>
          <dd className="text-cream">{photo.frameLabel}</dd>
          <dt>키오스크</dt>
          <dd className="text-cream">{photo.kioskLabel ?? "—"}</dd>
          <dt>세션</dt>
          <dd className="font-mono text-cream">{photo.sessionShort}</dd>
          <dt>링크</dt>
          <dd className="text-cream">
            {photo.linkActive ? `유효 (${formatTime(photo.tokenExpiresAt)}까지)` : "만료/삭제"}
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
              onClick={() => (a === "delete" ? setConfirmDelete(true) : run(a))}
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
        {showRecovery && photo.canShowQrAgain && <QrRecovery photoId={photo.id} />}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="사진을 삭제할까요?"
        confirmLabel="영구 삭제"
        danger
        busy={busy === "delete"}
        onConfirm={() => run("delete")}
        onCancel={() => setConfirmDelete(false)}
      >
        이미지가 즉시 지워지고, 방문객의 QR 링크도 더 이상 열리지 않아요. 되돌릴 수 없어요.
      </ConfirmDialog>
    </article>
  );
}
