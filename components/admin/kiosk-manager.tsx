"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { StaffKioskView } from "@/lib/ops/admin";
import { errorText, postJson } from "./api";
import { ConfirmDialog } from "./confirm-dialog";
import { HEALTH_LABEL, HEALTH_TONE, ago, formatTime } from "./labels";

export function KioskManager({ kiosks }: { kiosks: StaffKioskView[] }) {
  if (!kiosks.length)
    return (
      <p className="text-base text-ink/75">
        등록된 키오스크가 없어요. 아래에서 등록 코드를 만드세요.
      </p>
    );
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {kiosks.map((k) => (
        <KioskItem key={k.id} kiosk={k} />
      ))}
    </ul>
  );
}

function KioskItem({ kiosk }: { kiosk: StaffKioskView }) {
  const router = useRouter();
  const [label, setLabel] = useState(kiosk.label);
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(body: unknown) {
    setBusy(true);
    setError(null);
    const res = await postJson(`/api/admin/kiosks/${kiosk.id}`, body);
    setBusy(false);
    setConfirmRevoke(false);
    if (!res.ok) setError(errorText(res.error));
    router.refresh();
  }

  return (
    <li
      className="admin-card flex flex-col gap-3 p-4"
      data-testid="kiosk-item"
      data-kiosk-id={kiosk.id}
      data-health={kiosk.health}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="admin-h2">{kiosk.label}</h3>
        <span className={`admin-chip ${HEALTH_TONE[kiosk.health]}`}>
          {HEALTH_LABEL[kiosk.health]}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-base text-ink/75">
        <dt>마지막 신호</dt>
        <dd className="text-ink">{ago(kiosk.heartbeatAt)}</dd>
        <dt>전송 대기</dt>
        <dd className="text-ink">{kiosk.queueDepth === null ? "—" : `${kiosk.queueDepth}건`}</dd>
        <dt>카메라</dt>
        <dd className="text-ink">
          {kiosk.cameraState === "ok"
            ? "정상"
            : kiosk.cameraState === "error"
              ? "오류"
              : "알 수 없음"}
        </dd>
        {(kiosk.frameRate !== null || kiosk.memoryMb !== null) && (
          <>
            <dt>화면</dt>
            <dd className="text-ink" data-testid="kiosk-display-metrics">
              {kiosk.frameRate !== null ? `${kiosk.frameRate}fps` : "—"}
              {kiosk.memoryMb !== null && ` · 메모리 ${kiosk.memoryMb}MB`}
              {kiosk.frameRate !== null && kiosk.frameRate < 20 && (
                <span className="text-danger"> · 느려요 (저사양 모드 권장)</span>
              )}
            </dd>
          </>
        )}
        <dt>등록</dt>
        <dd className="text-ink">
          {formatTime(kiosk.createdAt)} ·{" "}
          {kiosk.enrolledVia === "code" ? "일회용 코드" : "공유 비밀번호(구버전)"}
        </dd>
        {kiosk.revokedAt && (
          <>
            <dt>해제</dt>
            <dd className="text-ink">{formatTime(kiosk.revokedAt)}</dd>
          </>
        )}
      </dl>
      {!kiosk.revokedAt && (
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="키오스크 이름"
            value={label}
            maxLength={40}
            onChange={(e) => setLabel(e.target.value)}
            className="admin-input min-w-0 basis-full"
          />
          <button
            type="button"
            className="admin-btn admin-btn-quiet flex-1"
            disabled={busy || !label.trim() || label === kiosk.label}
            onClick={() => send({ action: "rename", label })}
          >
            이름 변경
          </button>
          <button
            type="button"
            className="admin-btn admin-btn-danger flex-1"
            disabled={busy}
            onClick={() => setConfirmRevoke(true)}
            data-testid="kiosk-revoke"
          >
            등록 해제
          </button>
        </div>
      )}
      {error && <p className="text-danger">{error}</p>}
      <ConfirmDialog
        open={confirmRevoke}
        title={`"${kiosk.label}" 등록을 해제할까요?`}
        confirmLabel="등록 해제"
        danger
        busy={busy}
        onConfirm={() => send({ action: "revoke" })}
        onCancel={() => setConfirmRevoke(false)}
      >
        이 기기는 즉시 사진을 올리거나 미디어월을 보여줄 수 없게 돼요. 다시 쓰려면 새 등록 코드로
        등록해야 해요.
      </ConfirmDialog>
    </li>
  );
}

/** Staff generates a one-time code and types it on the new kiosk's /kiosk/enroll. */
export function EnrollmentCodeCreator() {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ code: string; label: string; expiresAt: string } | null>(
    null,
  );

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await postJson<{ code: string; label: string; expiresAt: string }>(
      "/api/admin/enrollment-codes",
      { label },
    );
    setBusy(false);
    if (!res.ok) {
      setError(errorText(res.error));
      return;
    }
    setResult(res.data);
    setLabel("");
    router.refresh();
  }

  return (
    <section className="admin-card flex flex-col gap-4 p-4">
      <h2 className="admin-h2">새 키오스크 등록</h2>
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input
          aria-label="새 키오스크 이름"
          placeholder="예: 본당 입구"
          required
          maxLength={40}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="admin-input min-w-0 flex-1"
        />
        <button
          type="submit"
          className="admin-btn admin-btn-primary"
          disabled={busy}
          data-testid="create-enrollment-code"
        >
          일회용 등록 코드 만들기
        </button>
      </form>
      {error && <p className="text-danger">{error}</p>}
      {result && (
        <div
          className="rounded-lg bg-backdrop p-4 text-center"
          data-testid="enrollment-code-result"
        >
          <p className="text-base text-ink/75">
            &ldquo;{result.label}&rdquo; 키오스크에서 /kiosk/enroll 을 열고 입력하세요
          </p>
          <p className="text-sm text-ink/75">
            미디어월 화면은 /kiosk/enroll?next=wall 에서 입력해요
          </p>
          <p
            className="my-3 font-mono text-5xl font-bold tracking-[0.2em] text-accent"
            data-testid="enrollment-code"
          >
            {result.code}
          </p>
          <p className="text-base text-ink/75">
            한 번만 쓸 수 있고 {formatTime(result.expiresAt)}에 만료돼요. 이 화면을 닫으면 다시 볼
            수 없어요.
          </p>
        </div>
      )}
    </section>
  );
}
