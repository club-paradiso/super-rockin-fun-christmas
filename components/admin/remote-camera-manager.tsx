"use client";

import { useCallback, useEffect, useState } from "react";
import { makeQrSvg } from "@/lib/qr";
import type { StaffCameraView } from "@/lib/remote-camera/admin";
import {
  QUALITY_MODES,
  QUALITY_PROFILES,
  type CameraErrorCode,
  type CameraQualityMode,
} from "@/lib/remote-camera/protocol";
import { errorText, postJson } from "./api";
import { ConfirmDialog } from "./confirm-dialog";
import { ago, formatTime } from "./labels";

const STATE_LABEL: Record<StaffCameraView["report"]["state"], string> = {
  offline: "연결 안 됨",
  idle: "대기 중",
  connecting: "연결 중",
  live: "연결됨",
  error: "문제 있음",
};
const STATE_TONE: Record<StaffCameraView["report"]["state"], string> = {
  offline: "bg-ink/10 text-ink/75",
  idle: "bg-ink/10 text-ink",
  connecting: "bg-alert text-button-text",
  live: "bg-approve text-button-text",
  error: "bg-danger text-button-text",
};

/** Staff words for the camera's stable error codes. */
export const CAMERA_ERROR_LABEL: Record<CameraErrorCode, string> = {
  permission_denied:
    "카메라 권한이 거부됐어요. 아이폰 설정 → Safari → 카메라를 ‘허용’으로 바꾸세요.",
  no_camera: "후면 카메라를 찾지 못했어요. 렌즈가 가려졌는지 확인하세요.",
  insecure_context: "https 주소가 아니라서 카메라를 못 켜요. 운영 서버(https) 주소로 여세요.",
  unsupported_browser: "아이폰의 Safari로 열어야 해요.",
  camera_failed: "카메라가 멈췄어요. 자동 복구 중이에요. 계속되면 ‘재연결’을 누르세요.",
  backgrounded: "아이폰 화면이 잠겼거나 다른 앱이 앞에 있어요. 페이지를 앞으로 가져오세요.",
  link_lost: "키오스크와 연결이 끊겼어요. 자동으로 다시 연결해요.",
  booth_gone: "키오스크가 응답하지 않아요.",
};

interface ListResponse {
  disabled: boolean;
  cameras?: StaffCameraView[];
  kiosks?: { id: string; label: string }[];
  iceProblem?: string | null;
}

async function getList(): Promise<ListResponse | null> {
  try {
    const res = await fetch("/api/admin/remote-camera", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (res.status === 401) {
      window.location.replace("/admin/login");
      return null;
    }
    return res.ok ? ((await res.json()) as ListResponse) : null;
  } catch {
    return null;
  }
}

export function RemoteCameraManager() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [stale, setStale] = useState(false);
  // Bumped after an action so the list reloads at once instead of at the next 3 s tick.
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const next = await getList();
      if (!alive) return;
      if (next) setData(next);
      setStale(!next);
    };
    void tick();
    const timer = setInterval(() => void tick(), 3_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [reload]);
  const refresh = useCallback(async () => setReload((n) => n + 1), []);

  if (!data) return <p className="admin-help">불러오는 중…</p>;
  if (data.disabled)
    return (
      <p className="admin-card p-4 text-base" data-testid="camera-switched-off">
        원격 카메라가 서버에서 꺼져 있어요 (REMOTE_CAMERA_DISABLED=1).
      </p>
    );
  const active = (data.cameras ?? []).filter((c) => !c.revokedAt);
  const revoked = (data.cameras ?? []).filter((c) => c.revokedAt).slice(0, 3);
  return (
    <div className="flex flex-col gap-4" data-testid="remote-camera-manager">
      {stale && <p className="text-danger">서버와 연결이 끊겼어요. 다시 불러오는 중…</p>}
      {data.iceProblem && <p className="admin-card p-3 text-danger">{data.iceProblem}</p>}
      {active.length === 0 && (
        <p className="admin-help">연결된 카메라가 없어요. 아래에서 연결 코드를 만드세요.</p>
      )}
      <ul className="grid gap-3 md:grid-cols-2">
        {active.map((c) => (
          <CameraCard key={c.id} camera={c} onChanged={refresh} />
        ))}
      </ul>
      <PairPanel kiosks={data.kiosks ?? []} />
      {revoked.length > 0 && (
        <section className="admin-card p-4">
          <h2 className="admin-h2 mb-2">최근 해제된 카메라</h2>
          <ul className="flex flex-col gap-1 text-base text-ink/75">
            {revoked.map((c) => (
              <li key={c.id}>
                {c.name} · {c.kioskLabel} · {formatTime(c.revokedAt!)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function CameraCard({
  camera,
  onChanged,
}: {
  camera: StaffCameraView;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const r = camera.report;

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setError(null);
    const res = await postJson(`/api/admin/remote-camera/${camera.id}`, { action, ...extra });
    setBusy(null);
    setConfirmRevoke(false);
    if (!res.ok) setError(errorText(res.error));
    await onChanged();
  }

  const res = (w: number | null, h: number | null) => (w && h ? `${w} × ${h}` : "—");
  return (
    <li
      className="admin-card flex flex-col gap-3 p-4"
      data-testid="camera-item"
      data-camera-id={camera.id}
      data-state={r.state}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="admin-h2">{camera.name}</h3>
        <span className={`admin-chip ${STATE_TONE[r.state]}`} data-testid="camera-state">
          {STATE_LABEL[r.state]}
        </span>
      </div>
      {r.error && (
        <p
          role="alert"
          className="text-[15px] font-semibold text-danger"
          data-testid="camera-error-text"
        >
          {CAMERA_ERROR_LABEL[r.error]}
        </p>
      )}
      {!camera.online && (
        <p className="text-[15px] text-alert">
          아이폰에서 신호가 없어요. 페이지가 열려 있고 화면이 켜져 있는지 확인하세요.
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-base text-ink/75">
        <dt>짝 키오스크</dt>
        <dd className="text-ink">{camera.kioskLabel}</dd>
        <dt>마지막 신호</dt>
        <dd className="text-ink" data-testid="camera-last-seen">
          {ago(camera.lastSeenAt)}
        </dd>
        <dt>미리보기 해상도</dt>
        <dd className="text-ink">{res(r.previewWidth, r.previewHeight)}</dd>
        <dt>실제 촬영 해상도</dt>
        <dd className="text-ink">{res(r.captureWidth, r.captureHeight)}</dd>
        <dt>화질 모드</dt>
        <dd className="text-ink">{QUALITY_PROFILES[r.mode].label}</dd>
        <dt>최근 촬영 지연</dt>
        <dd className="text-ink">
          {r.lastCaptureMs === null
            ? "—"
            : `${r.lastCaptureMs} ms (전송 ${r.lastTransferMs ?? "—"} ms, 인코딩 ${r.lastEncodeMs ?? "—"} ms)`}
        </dd>
        <dt>자동 복구</dt>
        <dd className="text-ink">{r.recovery}회</dd>
        <dt>페어링</dt>
        <dd className="text-ink">{formatTime(camera.createdAt)}</dd>
      </dl>
      {r.testThumb && (
        <div>
          {/* A 160 px thumbnail from the staff test, kept two minutes by the server. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={r.testThumb}
            alt="테스트 촬영 미리보기"
            data-testid="camera-test-thumb"
            className="rounded-[10px] border border-ink/15"
          />
          <p className="admin-help mt-1">
            테스트 촬영 {r.testAt ? ago(r.testAt) : ""} · 2분 뒤 사라져요
          </p>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <div className="admin-seg" role="radiogroup" aria-label="화질 모드">
          {QUALITY_MODES.map((m: CameraQualityMode) => (
            <button
              key={m}
              role="radio"
              aria-checked={r.mode === m}
              disabled={!!busy}
              className="admin-seg-btn"
              data-testid={`mode-${m}`}
              onClick={() => void act("setMode", { mode: m })}
            >
              {QUALITY_PROFILES[m].label.split(" ")[0]}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            className="admin-btn admin-btn-quiet"
            disabled={!!busy}
            data-testid="camera-test"
            onClick={() => void act("testCapture")}
          >
            테스트 촬영
          </button>
          <button
            className="admin-btn admin-btn-quiet"
            disabled={!!busy}
            data-testid="camera-reconnect"
            onClick={() => void act("reconnect")}
          >
            재연결
          </button>
          <button
            className="admin-btn admin-btn-quiet"
            disabled={!!busy}
            data-testid="camera-disconnect"
            onClick={() => void act("disconnect")}
          >
            연결 끊기
          </button>
          <button
            className="admin-btn admin-btn-danger"
            disabled={!!busy}
            data-testid="camera-revoke"
            onClick={() => setConfirmRevoke(true)}
          >
            페어링 해제
          </button>
        </div>
      </div>
      {error && <p className="text-danger">{error}</p>}
      <ConfirmDialog
        open={confirmRevoke}
        title="이 카메라의 페어링을 해제할까요?"
        confirmLabel="해제"
        danger
        busy={busy === "revoke"}
        onConfirm={() => void act("revoke")}
        onCancel={() => setConfirmRevoke(false)}
      >
        <p>
          해제하면 이 아이폰은 즉시 키오스크와 연결이 끊겨요. 다시 쓰려면 새 코드로 연결해야 해요.
        </p>
      </ConfirmDialog>
    </li>
  );
}

function PairPanel({ kiosks }: { kiosks: { id: string; label: string }[] }) {
  const [kioskId, setKioskId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    code: string;
    url: string;
    expiresAt: string;
    secure: boolean;
    kioskLabel: string;
    qr: string;
  } | null>(null);
  const selected = kioskId || kiosks[0]?.id || "";

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    const res = await postJson<{
      code: string;
      url: string;
      expiresAt: string;
      secure: boolean;
      kioskLabel: string;
    }>("/api/admin/remote-camera/link", { kioskId: selected });
    setBusy(false);
    if (!res.ok) return setError(errorText(res.error));
    setResult({ ...res.data, qr: await makeQrSvg(res.data.url) });
  }

  return (
    <section className="admin-card flex flex-col gap-3 p-4" data-testid="pair-panel">
      <h2 className="admin-h2">카메라 연결 (페어링)</h2>
      {kiosks.length === 0 ? (
        <p className="admin-help">먼저 키오스크를 등록하세요.</p>
      ) : (
        <form onSubmit={create} className="flex flex-wrap gap-2">
          <select
            aria-label="키오스크 선택"
            className="admin-input min-w-0 flex-1"
            value={selected}
            onChange={(e) => setKioskId(e.target.value)}
            data-testid="pair-kiosk"
          >
            {kiosks.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={busy}
            className="admin-btn admin-btn-primary"
            data-testid="pair-create"
          >
            연결 코드 만들기
          </button>
        </form>
      )}
      {error && <p className="text-danger">{error}</p>}
      {result && (
        <div className="rounded-lg bg-backdrop p-4 text-center" data-testid="pair-result">
          <p className="text-base text-ink/75">
            &ldquo;{result.kioskLabel}&rdquo; 키오스크에 연결할 아이폰에서 QR을 찍거나 코드를
            입력하세요
          </p>
          <div
            className="mx-auto my-3 w-48 [&>svg]:h-auto [&>svg]:w-full"
            data-testid="pair-qr"
            dangerouslySetInnerHTML={{ __html: result.qr }}
          />
          <p
            className="my-2 font-mono text-4xl font-bold tracking-[0.15em] text-accent"
            data-testid="pair-code-value"
          >
            {result.code}
          </p>
          <p className="text-base text-ink/75">
            한 번만 쓸 수 있고 {formatTime(result.expiresAt)}에 만료돼요. 주소:{" "}
            <span className="font-mono">/camera/remote</span>
          </p>
          {!result.secure && (
            <p className="mt-2 text-[15px] font-semibold text-danger" data-testid="pair-insecure">
              이 주소는 https가 아니라서 아이폰 카메라가 켜지지 않아요. 운영 서버(https) 주소의
              관리자 화면에서 만드세요.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
