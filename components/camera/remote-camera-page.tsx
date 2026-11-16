"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { defaultPhoneDeps, PhoneCamera, type PhoneView } from "@/lib/remote-camera/phone";
import {
  normalizePairingCode,
  QUALITY_PROFILES,
  type CameraErrorCode,
} from "@/lib/remote-camera/protocol";

/** Keeps the screen on where the browser allows it (Safari 16.4+). Elsewhere Auto-Lock must be Never. */
async function requestWakeLock() {
  try {
    const wl = (navigator as unknown as { wakeLock?: { request(t: "screen"): Promise<unknown> } })
      .wakeLock;
    if (wl) await wl.request("screen");
  } catch {
    // not available or refused: the checklist tells staff to turn Auto-Lock off
  }
}

type Phase = "checking" | "pair" | "ready" | "running";

const ERROR_TEXT: Record<CameraErrorCode, string> = {
  permission_denied:
    "카메라 사용이 거부됐어요. 설정 → Safari → 카메라에서 이 사이트를 '허용'으로 바꾼 뒤 페이지를 새로고침하세요.",
  no_camera: "카메라를 찾지 못했어요. 아이폰 후면 카메라가 가려지지 않았는지 확인하세요.",
  insecure_context:
    "https 주소로 열어야 카메라를 쓸 수 있어요. 주소가 http:// 로 시작하면 운영 서버(https) 주소로 다시 여세요.",
  unsupported_browser: "이 브라우저는 카메라를 지원하지 않아요. iPhone의 Safari로 여세요.",
  camera_failed: "카메라가 멈췄어요. 자동으로 다시 켜는 중이에요. 계속되면 '다시 연결'을 누르세요.",
  backgrounded: "다른 앱이 앞에 있거나 화면이 잠겼어요. 이 페이지를 앞으로 가져오세요.",
  link_lost: "키오스크와의 연결이 끊겼어요. 자동으로 다시 연결해요.",
  booth_gone: "키오스크가 응답하지 않아요.",
};

const STATE_TEXT: Record<PhoneView["state"], string> = {
  offline: "꺼짐",
  idle: "대기 중 (촬영 준비됨)",
  connecting: "키오스크와 연결 중…",
  live: "연결됨 · 촬영 가능",
  error: "문제 있음",
};

export function RemoteCameraPage({ initialCode = "" }: { initialCode?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const phone = useMemo(
    () => (typeof window === "undefined" ? null : new PhoneCamera(defaultPhoneDeps())),
    [],
  );
  const [phase, setPhase] = useState<Phase>("checking");
  const [view, setView] = useState<PhoneView | null>(null);
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState("iPhone 카메라");
  const [message, setMessage] = useState<string | null>(null);
  const [dim, setDim] = useState(false);
  const [busy, setBusy] = useState(false);

  // The code from the QR is removed from the address bar at once (it is single use anyway).
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("code")) {
      url.searchParams.delete("code");
      window.history.replaceState(null, "", url.pathname + url.search);
    }
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/camera/signal?after=0", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (alive) setPhase(res.ok ? "ready" : "pair");
      } catch {
        if (!alive) return;
        setPhase("pair");
        setMessage("서버에 연결하지 못했어요. Wi-Fi를 확인하세요.");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!phone) return;
    const off = phone.subscribe(setView);
    const onVis = () => {
      phone.onVisibilityChange();
      if (document.visibilityState === "visible") void requestWakeLock();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      off();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [phone]);

  async function pair(e: React.FormEvent) {
    e.preventDefault();
    const normalized = normalizePairingCode(code);
    if (!normalized) return setMessage("코드는 8자리예요. (예: ABCD-2345)");
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/camera/link", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: normalized, name }),
      });
      if (res.ok) setPhase("ready");
      else if (res.status === 429) setMessage("시도가 너무 많아요. 잠시 뒤에 다시 하세요.");
      else setMessage("코드가 틀렸거나 만료됐어요. 관리자 화면에서 새 코드를 만드세요.");
    } catch {
      setMessage("서버에 연결하지 못했어요.");
    } finally {
      setBusy(false);
    }
  }

  async function startCamera() {
    if (!phone || !videoRef.current) return;
    setBusy(true);
    await phone.start(videoRef.current);
    await requestWakeLock();
    setPhase("running");
    setBusy(false);
  }

  async function unpair() {
    if (!window.confirm("이 아이폰의 연결을 해제할까요? 다시 쓰려면 새 코드가 필요해요.")) return;
    phone?.stop();
    await fetch("/api/camera/unlink", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => {});
    setPhase("pair");
  }

  const revoked = !!view?.revoked;
  const shown: Phase = revoked ? "pair" : phase;
  const shownMessage = revoked
    ? "관리자가 이 연결을 해제했어요. 새 코드로 다시 연결하세요."
    : message;

  return (
    <main className="min-h-dvh bg-backdrop px-4 py-6 text-ink" data-testid="remote-camera-page">
      {/* The video must stay in the page and playing: the photo is cut from it. */}
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        data-testid="local-preview"
        className={
          shown === "running"
            ? "mx-auto mb-4 block h-40 w-auto max-w-full rounded-[10px] bg-black object-cover"
            : "pointer-events-none fixed h-px w-px opacity-0"
        }
      />
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <h1 className="admin-h1">원격 카메라</h1>

        {shown === "checking" && <p className="admin-help">확인 중…</p>}

        {shown === "pair" && (
          <form
            onSubmit={pair}
            className="admin-card flex flex-col gap-3 p-4"
            data-testid="pair-form"
          >
            <h2 className="admin-h2">1. 키오스크와 연결하기</h2>
            <p className="admin-help">
              관리자 화면(/admin) → 원격 카메라 → ‘카메라 연결’에서 만든 8자리 코드를 입력하세요.
              코드는 10분 동안, 한 번만 쓸 수 있어요.
            </p>
            <label className="flex flex-col gap-1 text-[15px] font-semibold">
              연결 코드
              <input
                data-testid="pair-code"
                className="admin-input text-center text-2xl tracking-[0.2em] uppercase"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                maxLength={9}
                placeholder="ABCD-2345"
              />
            </label>
            <label className="flex flex-col gap-1 text-[15px] font-semibold">
              이 카메라 이름 (선택)
              <input
                className="admin-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="admin-btn admin-btn-primary"
              data-testid="pair-submit"
            >
              연결하기
            </button>
            {shownMessage && (
              <p
                role="alert"
                className="text-[15px] font-semibold text-danger"
                data-testid="pair-message"
              >
                {shownMessage}
              </p>
            )}
          </form>
        )}

        {shown === "ready" && (
          <section className="admin-card flex flex-col gap-3 p-4" data-testid="start-panel">
            <h2 className="admin-h2">2. 카메라 켜기</h2>
            <p className="admin-help">
              아래 버튼을 누르면 Safari가 카메라 권한을 물어봐요. ‘허용’을 누르세요. (iPhone은 직접
              누른 뒤에만 카메라를 켤 수 있어요.)
            </p>
            <button
              onClick={startCamera}
              disabled={busy}
              className="admin-btn admin-btn-primary min-h-14 text-lg"
              data-testid="start-camera"
            >
              카메라 시작
            </button>
          </section>
        )}

        {shown === "running" && view && (
          <section
            className="admin-card flex flex-col gap-3 p-4"
            data-testid="status-panel"
            data-state={view.state}
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="admin-h2">{STATE_TEXT[view.state]}</h2>
              <span className="admin-chip bg-ink/10 text-ink" data-testid="shots">
                촬영 {view.shots}장
              </span>
            </div>
            {view.error && (
              <p
                role="alert"
                className="text-[15px] font-semibold text-danger"
                data-testid="camera-error"
              >
                {ERROR_TEXT[view.error]}
              </p>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[15px] text-ink/75">
              <dt>카메라 화질</dt>
              <dd className="text-ink">
                {view.feedWidth && view.feedHeight ? `${view.feedWidth}×${view.feedHeight}` : "—"} (
                {QUALITY_PROFILES[view.mode].label})
              </dd>
              <dt>후면 카메라</dt>
              <dd className="text-ink">
                {view.rearFacing === null
                  ? "확인 불가"
                  : view.rearFacing
                    ? "예"
                    : "아니요 — 전면일 수 있어요"}
              </dd>
              <dt>자동 복구 횟수</dt>
              <dd className="text-ink">{view.recovery}</dd>
            </dl>
            <div className="grid grid-cols-2 gap-2">
              <button
                className="admin-btn admin-btn-quiet"
                onClick={() => void phone?.runCommand({ name: "reconnect" })}
              >
                다시 연결
              </button>
              <button
                className="admin-btn admin-btn-quiet"
                onClick={() => setDim(true)}
                data-testid="dim"
              >
                화면 어둡게
              </button>
              <button className="admin-btn admin-btn-quiet col-span-2" onClick={unpair}>
                이 아이폰 연결 해제
              </button>
            </div>
          </section>
        )}

        <details className="admin-card p-4 text-[15px] leading-relaxed">
          <summary className="admin-h2 cursor-pointer">설치 체크리스트 (스태프)</summary>
          <ol className="mt-3 list-decimal space-y-1 pl-5">
            <li>충전기를 연결하고, 설정 → 디스플레이 및 밝기 → 자동 잠금을 ‘안 함’으로 바꿔요.</li>
            <li>Safari로 이 페이지를 열고 코드를 입력한 뒤 ‘카메라 시작’을 눌러요.</li>
            <li>
              설정 → 손쉬운 사용 → 안내 접근을 켜고, 이 페이지에서 안내 접근을 시작해요 (실수로 앱을
              나가지 않게).
            </li>
            <li>후면 카메라가 손님 쪽을 보게 거치하고, 렌즈를 닦아요.</li>
            <li>
              잠금 화면이나 다른 앱이 앞에 있으면 사진이 안 찍혀요. 그럴 땐 이 페이지를 다시 앞으로
              가져오세요.
            </li>
          </ol>
        </details>
      </div>

      {dim && (
        <button
          aria-label="화면 밝게"
          data-testid="dim-overlay"
          onClick={() => setDim(false)}
          className="fixed inset-0 z-50 flex items-end justify-center bg-black pb-8"
        >
          <span className="text-sm text-white/40">
            {view ? STATE_TEXT[view.state] : ""} · 화면을 누르면 밝아져요
          </span>
        </button>
      )}
    </main>
  );
}
