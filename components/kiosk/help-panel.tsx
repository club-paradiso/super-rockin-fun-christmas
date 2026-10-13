"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { KIOSK_CONFIG } from "@/config/kiosk";
import type { CameraDevice } from "@/lib/camera";
import {
  HELP_CLOSED,
  HELP_PIN_LENGTH,
  helpReducer,
  type HelpDenial,
  type HelpStaff,
} from "@/lib/kiosk/help";

export interface HelpQueueView {
  uploads: { sessionId: string; attempts: number; lastError: string | null; state: string }[];
  consents: number;
}

const DENIAL_COPY: Record<HelpDenial, string> = {
  wrong: "PIN이 맞지 않아요.",
  locked: "잘못된 PIN이 많아 잠시 잠겼어요. 15분 뒤 다시 해 주세요.",
  offline: "허브에 연결할 수 없어요. 잠시 뒤 다시 해 주세요.",
};
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"] as const;

/**
 * Staff help mode (hub). An invisible corner button opens it after a 3-second hold, so a guest
 * tapping around never lands here; the PIN is checked by the hub (/api/kiosk/help), which issues
 * no staff session. Everything in the menu acts on this booth only.
 */
export function HelpPanel(p: {
  listDevices: () => Promise<CameraDevice[]>;
  deviceId: string | undefined;
  onSelectDevice: (id: string) => void;
  loadQueue: () => Promise<HelpQueueView>;
  onSendNow: () => Promise<void>;
  onReset: () => void;
}) {
  const [state, dispatch] = useReducer(helpReducer, HELP_CLOSED);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = state.step !== "closed";

  const startHold = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = setTimeout(
      () => dispatch({ type: "OPEN" }),
      KIOSK_CONFIG.helpHoldSeconds * 1000,
    );
  };
  const endHold = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
  };

  // Names to pick from, fetched when the panel opens (never kept in the page).
  const picking = state.step === "pick" && !state.staff && !state.failed;
  useEffect(() => {
    if (!picking) return;
    let stale = false;
    fetch("/api/kiosk/help", { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const { staff } = (await r.json()) as { staff: HelpStaff[] };
        if (!stale) dispatch({ type: "STAFF_LOADED", staff });
      })
      .catch(() => !stale && dispatch({ type: "STAFF_FAILED" }));
    return () => {
      stale = true;
    };
  }, [picking]);

  // Six digits typed: ask the hub.
  const pinReady = state.step === "pin" && state.pin.length === HELP_PIN_LENGTH && !state.checking;
  useEffect(() => {
    if (!pinReady || state.step !== "pin") return;
    const { who, pin } = state;
    dispatch({ type: "CHECKING" });
    fetch("/api/kiosk/help", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: who.userId, pin }),
    })
      .then(async (r) => {
        if (r.ok) {
          const { displayName } = (await r.json()) as { displayName: string };
          dispatch({ type: "UNLOCKED", displayName });
        } else {
          dispatch({ type: "DENIED", reason: r.status === 429 ? "locked" : "wrong" });
        }
      })
      .catch(() => dispatch({ type: "DENIED", reason: "offline" }));
  }, [pinReady, state]);

  // Closes itself when left alone, so the next guest never finds it open.
  useEffect(() => {
    if (!open) return;
    let timer = setTimeout(() => dispatch({ type: "CLOSE" }), KIOSK_CONFIG.helpIdleSeconds * 1000);
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => dispatch({ type: "CLOSE" }), KIOSK_CONFIG.helpIdleSeconds * 1000);
    };
    window.addEventListener("pointerdown", bump);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", bump);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label={`스태프 도움 (${KIOSK_CONFIG.helpHoldSeconds}초 누르기)`}
        data-testid="help-corner"
        className="fixed left-0 top-0 z-40 h-24 w-24 opacity-0"
        onPointerDown={startHold}
        onPointerUp={endHold}
        onPointerLeave={endHold}
        onPointerCancel={endHold}
        onContextMenu={(e) => e.preventDefault()}
      />
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="스태프 도움"
          data-testid="help-panel"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/95 p-6"
        >
          <div className="flex max-h-full w-full max-w-2xl flex-col gap-6 overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-3xl font-bold text-cream">
                스태프 도움{state.step === "menu" ? ` · ${state.displayName}` : ""}
              </h2>
              <button
                type="button"
                className="btn-quiet"
                data-testid="help-close"
                onClick={() => dispatch({ type: "CLOSE" })}
              >
                닫기
              </button>
            </div>

            {state.step === "pick" && (
              <div className="flex flex-col gap-3">
                <p className="text-xl text-mist">이름을 고르세요.</p>
                {state.failed && <p className="text-xl text-alert">{DENIAL_COPY.offline}</p>}
                {!state.staff && !state.failed && <p className="text-xl text-mist">불러오는 중…</p>}
                {state.staff?.map((s) => (
                  <button
                    key={s.userId}
                    type="button"
                    className="btn-secondary"
                    onClick={() => dispatch({ type: "PICK", userId: s.userId })}
                  >
                    {s.displayName}
                  </button>
                ))}
              </div>
            )}

            {state.step === "pin" && (
              <div className="flex flex-col gap-4">
                <p className="text-xl text-mist">{state.who.displayName} 님의 PIN 6자리</p>
                <div
                  className="flex justify-center gap-3"
                  aria-label={`PIN ${state.pin.length}/${HELP_PIN_LENGTH}자리 입력됨`}
                >
                  {Array.from({ length: HELP_PIN_LENGTH }, (_, i) => (
                    <span
                      key={i}
                      className={`h-6 w-6 rounded-full border-2 border-cream/60 ${i < state.pin.length ? "bg-amber" : ""}`}
                    />
                  ))}
                </div>
                {state.denied && (
                  <p className="text-center text-xl text-alert" data-testid="help-denied">
                    {DENIAL_COPY[state.denied]}
                  </p>
                )}
                <div className="grid grid-cols-3 gap-3">
                  {KEYS.map((k, i) =>
                    k === "" ? (
                      <span key={i} />
                    ) : (
                      <button
                        key={i}
                        type="button"
                        aria-label={k === "⌫" ? "지우기" : k}
                        disabled={state.checking}
                        className="min-h-20 rounded-2xl bg-dusk text-3xl font-bold text-cream"
                        onClick={() =>
                          dispatch({
                            type: "PIN",
                            pin: k === "⌫" ? state.pin.slice(0, -1) : state.pin + k,
                          })
                        }
                      >
                        {k}
                      </button>
                    ),
                  )}
                </div>
                <button
                  type="button"
                  className="btn-quiet"
                  onClick={() => dispatch({ type: "BACK" })}
                >
                  다른 이름 고르기
                </button>
              </div>
            )}

            {state.step === "menu" && (
              <HelpMenu {...p} onClose={() => dispatch({ type: "CLOSE" })} />
            )}
          </div>
        </div>
      )}
    </>
  );
}

function HelpMenu(p: {
  listDevices: () => Promise<CameraDevice[]>;
  deviceId: string | undefined;
  onSelectDevice: (id: string) => void;
  loadQueue: () => Promise<HelpQueueView>;
  onSendNow: () => Promise<void>;
  onReset: () => void;
  onClose: () => void;
}) {
  const [devices, setDevices] = useState<CameraDevice[] | null>(null);
  const [queue, setQueue] = useState<HelpQueueView | null>(null);
  const [sending, setSending] = useState(false);
  const { listDevices, loadQueue } = p;

  useEffect(() => {
    void listDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
    void loadQueue().then(setQueue);
  }, [listDevices, loadQueue]);

  return (
    <div className="flex flex-col gap-6 text-cream" data-testid="help-menu">
      <section className="flex flex-col gap-2">
        <h3 className="text-2xl font-bold">카메라</h3>
        {devices === null ? (
          <p className="text-lg text-mist">찾는 중…</p>
        ) : (
          <select
            aria-label="카메라 선택"
            data-testid="help-camera"
            className="min-h-16 rounded-2xl bg-night px-4 text-xl text-cream"
            value={p.deviceId ?? ""}
            onChange={(e) => p.onSelectDevice(e.target.value)}
          >
            <option value="">기본 카메라</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        )}
      </section>

      <section className="flex flex-col gap-2" data-testid="help-queue">
        <h3 className="text-2xl font-bold">보내지 못한 것</h3>
        {queue === null ? (
          <p className="text-lg text-mist">확인 중…</p>
        ) : queue.uploads.length === 0 && queue.consents === 0 ? (
          <p className="text-lg text-mist">없어요. 모두 허브에 도착했어요.</p>
        ) : (
          <>
            <ul className="flex flex-col gap-1 text-lg">
              {queue.uploads.map((u) => (
                <li key={u.sessionId}>
                  사진 · 세션 {u.sessionId.slice(0, 8)} · {u.attempts}번 시도
                  {u.state === "auth" ? " · 기기 등록 필요" : ""}
                  {u.lastError ? ` · ${u.lastError}` : ""}
                </li>
              ))}
              {queue.consents > 0 && <li>미디어월 답변 {queue.consents}건</li>}
            </ul>
            <button
              type="button"
              className="btn-secondary"
              disabled={sending}
              onClick={async () => {
                setSending(true);
                await p.onSendNow().catch(() => undefined);
                setQueue(await loadQueue());
                setSending(false);
              }}
            >
              {sending ? "보내는 중…" : "지금 다시 보내기"}
            </button>
          </>
        )}
      </section>

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          className="btn-secondary"
          data-testid="help-reset"
          onClick={() => {
            p.onReset();
            p.onClose();
          }}
        >
          처음으로
        </button>
        <button
          type="button"
          className="btn-secondary"
          data-testid="help-reload"
          onClick={() => window.location.reload()}
        >
          화면 새로고침
        </button>
      </div>
      <p className="text-base text-mist">
        처음으로: 지금 찍던 사진은 지워져요. 보내는 중이던 사진은 그대로 보내요.
      </p>
    </div>
  );
}
