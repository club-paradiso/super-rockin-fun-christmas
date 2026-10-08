import { formatTime } from "@/components/admin/labels";
import { listAudit } from "@/lib/ops/admin";
import { requireStaff } from "@/lib/staff-auth/page";

export const dynamic = "force-dynamic";

const ACTION: Record<string, string> = {
  approve: "승인",
  reject: "반려",
  hide: "숨김",
  unhide: "다시 보이기",
  reopen: "다시 검수",
  delete: "삭제",
  retention_delete: "보관 기간 만료 삭제",
  guest_consent_yes: "방문객 미디어월 동의",
  guest_consent_no: "방문객 미디어월 거절",
  rotate_token: "QR 다시 발급",
  rename_kiosk: "키오스크 이름 변경",
  revoke_kiosk: "키오스크 등록 해제",
  create_enrollment_code: "등록 코드 생성",
  use_enrollment_code: "등록 코드 사용",
  update_settings: "긴급 설정 변경",
  add_staff: "스태프 추가",
  deactivate_staff: "스태프 비활성화",
  activate_staff: "스태프 활성화",
  update_staff: "스태프 정보 변경",
};

/** Append-only history of every state-changing action (read-only views are not logged). */
export default async function AuditPage() {
  await requireStaff();
  const events = await listAudit({ limit: 200 });
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-3xl font-bold">기록</h1>
      <p className="text-base text-mist">최근 200건 · 수정·삭제할 수 없는 기록이에요.</p>
      <ol className="flex flex-col gap-2" data-testid="audit-list">
        {events.map((e) => (
          <li
            key={e.id}
            className="admin-card flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3 text-base"
            data-testid="audit-item"
            data-action={e.action}
          >
            <span className="font-mono text-mist">{formatTime(e.occurredAt)}</span>
            <strong className="text-lg">{ACTION[e.action] ?? e.action}</strong>
            <span className="text-mist">{e.actorLabel}</span>
            {e.fromState && e.toState && e.subjectType === "photo" && (
              <span>
                {e.fromState} → {e.toState}
              </span>
            )}
            <span className="font-mono text-sm text-mist">
              {e.subjectType}:{e.subjectId.slice(0, 8)}
            </span>
            {e.note && <span className="w-full text-mist">메모: {e.note}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
