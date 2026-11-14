"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AiOverview } from "@/lib/ops/admin";
import type { EventSettings } from "@/lib/storage/types";
import { REASON_LABEL_KO } from "@/config/moderation";
import { errorText, postJson } from "./api";
import { ConfirmDialog } from "./confirm-dialog";
import { ago, formatTime } from "./labels";

/**
 * Who approves photos for the wall, and how the automatic check is doing (D95).
 *
 * One switch: 자동 확인 (the AI approves what it finds clearly fine) or 사람이 확인 (every photo
 * waits for a person). Turning it on asks first, because from then on guests' photos leave this
 * server. Everything shown is measured here; the usage figure is our own count, labelled as an
 * estimate of the provider's quota, never as its balance.
 */
export function AiReviewPanel({
  ai,
  settings,
}: {
  ai: AiOverview;
  settings: Pick<EventSettings, "pauseSubmissions" | "pauseWall" | "showHoldingScreen">;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function set(mode: "auto" | "manual") {
    setBusy(true);
    setMessage(null);
    const res = await postJson("/api/admin/settings", { moderationMode: mode });
    setBusy(false);
    setConfirming(false);
    setMessage(
      res.ok
        ? mode === "auto"
          ? "자동 확인을 켰어요. 지금부터 미디어월에 동의한 사진을 AI가 먼저 봐요."
          : "사람이 확인하도록 바꿨어요. 지금부터 모든 사진이 검수 대기로 와요."
        : errorText(res.error),
    );
    router.refresh();
  }

  const auto = ai.mode === "auto";
  const blackout = settings.pauseWall || settings.showHoldingScreen;
  const usedUp = ai.usage.requests >= ai.dailyLimit && ai.dailyLimit > 0;
  const nearLimit = !usedUp && ai.dailyLimit > 0 && ai.usage.requests >= ai.dailyLimit * 0.8;
  const failing =
    ai.usage.lastFailureAt !== null &&
    (ai.usage.lastSuccessAt === null || ai.usage.lastFailureAt > ai.usage.lastSuccessAt);
  const waiting = ai.pending.QUEUED;
  const forPeople = Object.entries(ai.pending)
    .filter(([status]) => status !== "QUEUED")
    .reduce((n, [, count]) => n + count, 0);

  return (
    <section className="admin-card flex flex-col gap-3 p-4" data-testid="ai-review-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="admin-h2">사진 확인 방식</h2>
        <p className="flex items-center gap-1.5 text-sm font-semibold" data-testid="ai-mode">
          <span
            aria-hidden
            className={`size-2 shrink-0 rounded-full ${ai.active ? "bg-approve" : "bg-ink/40"}`}
          />
          {ai.active ? "자동 확인 (AI) + 사람" : "사람이 모두 확인"}
        </p>
      </div>

      {/* The one line a volunteer reads first: what is happening to photos right now. */}
      <ul className="flex flex-col gap-1 text-base" data-testid="operating-mode">
        {blackout && (
          <li className="font-semibold text-danger">
            미디어월에서 사진을 모두 내린 상태예요 (긴급 제어가 켜져 있어요).
          </li>
        )}
        {settings.pauseSubmissions && (
          <li className="font-semibold text-danger">새 게시 신청을 받지 않는 중이에요.</li>
        )}
        <li>
          {ai.active
            ? "AI가 문제없다고 본 사진만 바로 승인돼요. 나머지는 검수 대기로 와요."
            : "모든 사진이 검수 대기로 오고, 스태프가 승인해야 미디어월에 나와요."}
        </li>
      </ul>

      {!ai.configured ? (
        <p className="admin-help" data-testid="ai-not-configured">
          이 서버에는 AI 확인 서비스가 설정되어 있지 않아요. 지금처럼 사람이 모두 확인해요.
          {ai.problem && (
            <>
              <br />
              <span className="text-danger">설정 오류 (기술 담당에게 전달): {ai.problem}</span>
            </>
          )}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
            <dt className="text-ink/75">AI 서비스</dt>
            <dd data-testid="ai-health">
              {ai.pausedUntil ? (
                <span className="text-danger">
                  응답이 없어 잠시 쉬는 중 ({formatTime(ai.pausedUntil)}까지). 사진은 검수 대기로
                  와요.
                </span>
              ) : failing ? (
                <span className="text-danger">
                  마지막 확인이 실패했어요 ({ago(ai.usage.lastFailureAt)}
                  {ai.usage.lastFailureReason
                    ? ` · ${REASON_LABEL_KO[ai.usage.lastFailureReason] ?? "오류"}`
                    : ""}
                  )
                </span>
              ) : ai.usage.lastSuccessAt ? (
                <>정상 · 마지막 확인 {ago(ai.usage.lastSuccessAt)}</>
              ) : (
                "오늘 아직 확인한 사진이 없어요"
              )}
            </dd>
            <dt className="text-ink/75">오늘 사용량</dt>
            <dd className={usedUp || nearLimit ? "text-danger" : undefined} data-testid="ai-usage">
              {ai.usage.requests} / {ai.dailyLimit}회 (이 서버가 센 추정치)
              {usedUp && " · 한도를 다 써서 남은 사진은 사람이 확인해요"}
              {nearLimit && " · 한도에 가까워요"}
            </dd>
            <dt className="text-ink/75">오늘 결과</dt>
            <dd>
              자동 승인 {ai.usage.approved} · 주의 표시 {ai.usage.flagged} · 실패 {ai.usage.failed}
            </dd>
            <dt className="text-ink/75">지금 대기</dt>
            <dd data-testid="ai-pending">
              AI 확인 중 {waiting} · 사람 확인 필요 {forPeople}
            </dd>
          </dl>
          <p className="admin-help">
            {ai.provider} · {ai.model}
          </p>
          <div>
            <button
              type="button"
              className={`admin-btn ${auto ? "admin-btn-quiet" : "admin-btn-primary"}`}
              disabled={busy}
              onClick={() => (auto ? void set("manual") : setConfirming(true))}
              data-testid="ai-mode-toggle"
            >
              {busy ? "…" : auto ? "사람이 모두 확인하기로 바꾸기" : "자동 확인 켜기"}
            </button>
          </div>
        </>
      )}
      {message && (
        <p role="status" className="text-base text-ink/75" data-testid="ai-mode-message">
          {message}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        title="자동 확인을 켤까요?"
        confirmLabel="켜기"
        busy={busy}
        onConfirm={() => void set("auto")}
        onCancel={() => setConfirming(false)}
      >
        <p>
          켜면 미디어월에 동의한 사진의 작은 사본이 외부 AI 서비스로 전송돼요. 부스 화면에는 이
          사실을 따로 안내하지 않아요.
        </p>
        <p className="mt-2">
          AI는 틀릴 수 있어요. 켠 뒤에도 미디어월을 지켜보고, 이상한 사진은 바로 숨겨 주세요.
        </p>
      </ConfirmDialog>
    </section>
  );
}
