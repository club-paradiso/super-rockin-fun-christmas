"use client";

import { useEffect, useRef } from "react";

/** Accessible modal confirmation (native <dialog>), large touch targets. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="m-auto w-[min(92vw,30rem)] rounded-3xl border border-ink/15 bg-paper p-0 text-ink backdrop:bg-ink/70"
      data-testid="confirm-dialog"
    >
      <div className="flex flex-col gap-5 p-6">
        <h2 className="text-2xl font-bold">{title}</h2>
        <div className="text-lg leading-relaxed text-ink/75">{children}</div>
        <div className="flex flex-wrap justify-end gap-3">
          <button
            type="button"
            className="admin-btn admin-btn-quiet"
            onClick={onCancel}
            disabled={busy}
          >
            취소
          </button>
          <button
            type="button"
            className={`admin-btn ${danger ? "admin-btn-danger" : "admin-btn-primary"}`}
            onClick={onConfirm}
            disabled={busy}
            data-testid="confirm-dialog-confirm"
          >
            {busy ? "처리 중…" : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
