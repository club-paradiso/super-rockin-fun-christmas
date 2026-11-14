"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "./api";
import { ConfirmDialog } from "./confirm-dialog";

const PHRASE = "행사 종료";

/**
 * "행사 종료 처리" (docs/RUNBOOK.md 8): deletes every photo on the hub and sends the cloud
 * deletes. Shown on the hub only. Two steps on purpose: type the phrase, then confirm.
 */
export function EventClose({
  photosLeft,
  eventEnd,
  allowed,
}: {
  photosLeft: number;
  /** Formatted EVENT_END_AT, or null when it is not configured. */
  eventEnd: string | null;
  allowed: boolean;
}) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <section className="admin-card flex flex-col gap-3 p-4" data-testid="event-close">
      <h2 className="text-xl font-bold">행사 종료 처리</h2>
      <p className="text-base text-ink/75">
        행사가 끝난 뒤 한 번만 누르세요. 이 노트북의 사진 <b className="text-ink">{photosLeft}장</b>
        을 모두 지우고, 미디어월 게시 신청과 미디어월을 멈추고, QR 서버(클라우드)의 사본도 지워
        달라고 요청해요. 되돌릴 수 없어요. 기록에는 누가 지웠는지 남아요.
      </p>
      <p className="text-base text-ink/75">
        {eventEnd
          ? `행사 종료 시각: ${eventEnd}. 그 전에는 누를 수 없어요. 누르지 않아도 종료 24시간 뒤 저절로 지워져요.`
          : "행사 종료 시각(EVENT_END_AT)이 설정되지 않았어요. 기술 담당에게 확인한 뒤 누르세요."}
      </p>
      <label className="flex flex-col gap-1 text-base">
        확인을 위해 <b>{PHRASE}</b>라고 적어 주세요
        <input
          className="admin-input"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          disabled={!allowed || busy}
          data-testid="event-close-phrase"
          autoComplete="off"
        />
      </label>
      <button
        type="button"
        className="admin-btn-danger"
        disabled={!allowed || busy || typed.trim() !== PHRASE}
        onClick={() => setOpen(true)}
        data-testid="event-close-open"
      >
        모든 사진 지우기
      </button>
      {message && (
        <p className="text-base" role="status" data-testid="event-close-message">
          {message}
        </p>
      )}
      <ConfirmDialog
        open={open}
        title="정말 모든 사진을 지울까요?"
        confirmLabel="모두 지우기"
        danger
        busy={busy}
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          setBusy(true);
          const res = await postJson<{
            deleted: number;
            failed: number;
            cloudQueued: number;
            incomplete: boolean;
          }>("/api/admin/event-close", { confirm: PHRASE });
          setBusy(false);
          setOpen(false);
          setTyped("");
          if (res.ok) {
            const d = res.data;
            setMessage(
              `${d.deleted}장을 지웠어요.` +
                (d.cloudQueued
                  ? ` 클라우드 사본 ${d.cloudQueued}장은 인터넷이 되면 지워져요.`
                  : "") +
                (d.incomplete ? " 남은 사진이 있어요. 한 번 더 눌러 주세요." : ""),
            );
          } else if (res.error === "event_not_over") {
            setMessage("아직 행사 종료 시각 전이에요.");
          } else {
            setMessage("지우지 못했어요. 다시 시도해 주세요.");
          }
          router.refresh();
        }}
      >
        <p className="text-base">
          이 노트북의 사진 {photosLeft}장과 QR 링크가 모두 사라져요. 손님 휴대폰에 이미 저장된
          사진은 그대로예요.
        </p>
      </ConfirmDialog>
    </section>
  );
}
