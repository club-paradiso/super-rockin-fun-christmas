"use client";

import { useState } from "react";
import { makeQrSvg } from "@/lib/qr";
import { errorText, postJson } from "./api";
import { ConfirmDialog } from "./confirm-dialog";
import { formatTime } from "./labels";

/**
 * "QR 다시 보여주기": only on explicit confirmation does the server rotate the token. The new QR
 * is shown here for the guest to scan; the previous QR stops working.
 */
export function QrRecovery({ photoId }: { photoId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; expiresAt: string; svg: string } | null>(
    null,
  );

  async function rotate() {
    setBusy(true);
    setError(null);
    const res = await postJson<{ url: string; expiresAt: string }>(
      `/api/admin/photos/${photoId}/rotate-token`,
      {},
    );
    setBusy(false);
    setConfirming(false);
    if (!res.ok) {
      setError(errorText(res.error));
      return;
    }
    setResult({ ...res.data, svg: await makeQrSvg(res.data.url) });
  }

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="admin-btn admin-btn-primary"
        onClick={() => setConfirming(true)}
        data-testid="qr-again"
      >
        QR 다시 보여주기
      </button>
      {error && <p className="text-base text-danger">{error}</p>}
      {result && (
        <div
          className="flex flex-col items-center gap-3 rounded-lg bg-ink/10 p-4"
          data-testid="qr-again-result"
          data-url={result.url}
        >
          <div
            className="w-64 rounded-lg bg-white p-3"
            dangerouslySetInnerHTML={{ __html: result.svg }}
          />
          <p className="text-center text-base text-ink/75">
            방문객 휴대폰 카메라로 비춰 주세요. {formatTime(result.expiresAt)}까지 유효.
          </p>
          <p className="break-all text-center font-mono text-sm text-ink/75">{result.url}</p>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title="새 QR을 만들까요?"
        confirmLabel="새 QR 만들기"
        busy={busy}
        onConfirm={rotate}
        onCancel={() => setConfirming(false)}
      >
        이전 QR과 링크는 <strong className="text-ink">더 이상 작동하지 않아요.</strong> 사진은
        그대로예요.
      </ConfirmDialog>
    </div>
  );
}
