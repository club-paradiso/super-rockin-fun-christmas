import type { ModerationAction } from "@/lib/ops/moderation";
import type { KioskHealth } from "@/lib/ops/kiosks";
import type { ModerationStatus } from "@/lib/storage/types";

export const STATUS_LABEL: Record<ModerationStatus, string> = {
  NONE: "미신청",
  PENDING: "검수 대기",
  APPROVED: "승인됨",
  REJECTED: "반려됨",
  HIDDEN: "숨김",
  DELETED: "삭제됨",
};

export const STATUS_TONE: Record<ModerationStatus, string> = {
  NONE: "bg-dusk text-mist",
  PENDING: "bg-amber text-ink",
  APPROVED: "bg-pine text-cream",
  REJECTED: "bg-dusk text-cream",
  HIDDEN: "bg-dusk text-amber",
  DELETED: "bg-alert/80 text-ink",
};

export const ACTION_LABEL: Record<ModerationAction, string> = {
  approve: "승인",
  reject: "반려",
  hide: "숨기기",
  unhide: "다시 보이기",
  reopen: "다시 검수",
  delete: "삭제",
};

export const HEALTH_LABEL: Record<KioskHealth, string> = {
  online: "온라인",
  stale: "응답 지연",
  offline: "오프라인",
  revoked: "등록 해제됨",
};

export const HEALTH_TONE: Record<KioskHealth, string> = {
  online: "bg-pine text-cream",
  stale: "bg-amber text-ink",
  offline: "bg-alert/80 text-ink",
  revoked: "bg-dusk text-mist",
};

const timeFmt = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
export const formatTime = (iso: string | null) => (iso ? timeFmt.format(new Date(iso)) : "—");

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "기록 없음";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86_400) return `${Math.round(s / 3600)}시간 전`;
  return `${Math.round(s / 86_400)}일 전`;
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
