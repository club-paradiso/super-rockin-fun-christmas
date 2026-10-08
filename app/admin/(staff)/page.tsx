import Link from "next/link";
import { EmergencyPanel } from "@/components/admin/emergency-panel";
import { STATUS_LABEL, ago, formatBytes, formatTime } from "@/components/admin/labels";
import { getOverview } from "@/lib/ops/admin";
import { requireStaff } from "@/lib/staff-auth/page";
import { MODERATION_STATES } from "@/lib/storage/types";

export const dynamic = "force-dynamic";

function Tile({
  label,
  value,
  sub,
  href,
  testId,
}: {
  label: string;
  value: string;
  sub?: string;
  href?: string;
  testId?: string;
}) {
  const body = (
    <>
      <p className="text-base text-mist">{label}</p>
      <p className="mt-1 text-4xl font-bold" data-testid={testId}>
        {value}
      </p>
      {sub && <p className="mt-1 text-base text-mist">{sub}</p>}
    </>
  );
  return href ? (
    <Link href={href} className="admin-card block p-4 hover:border-amber/60">
      {body}
    </Link>
  ) : (
    <div className="admin-card p-4">{body}</div>
  );
}

export default async function OverviewPage() {
  await requireStaff();
  const o = await getOverview();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-bold">개요</h1>
      <EmergencyPanel settings={o.settings} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          label="검수 대기"
          value={`${o.pendingCount}`}
          sub="미디어월 신청 사진"
          href="/admin/moderation"
          testId="tile-pending"
        />
        <Tile
          label="키오스크"
          value={`${o.kiosks.online} 온라인`}
          sub={`지연 ${o.kiosks.stale} · 오프라인 ${o.kiosks.offline}`}
          href="/admin/kiosks"
          testId="tile-kiosks"
        />
        <Tile
          label="키오스크 전송 대기"
          value={`${o.kiosks.queueDepth}건`}
          sub="온라인·지연 키오스크 보고 기준"
        />
        <Tile
          label="보관 중 사진"
          value={`${o.storedCount}장`}
          sub={`${formatBytes(o.storedBytes)} (DB 기록 기준)`}
        />
      </div>
      <section className="admin-card p-4">
        <h2 className="mb-2 text-xl font-bold">마지막 자동 정리</h2>
        {o.lastRetention ? (
          <p className="text-lg">
            {formatTime(o.lastRetention.ranAt)} ({ago(o.lastRetention.ranAt)}) · 삭제{" "}
            {o.lastRetention.deleted}건
            {o.lastRetention.failed > 0 && (
              <span className="text-alert"> · 실패 {o.lastRetention.failed}건</span>
            )}
          </p>
        ) : (
          <p className="text-lg text-mist">아직 실행 기록이 없어요 (매일 03:17 KST 실행).</p>
        )}
      </section>
      <section className="admin-card p-4">
        <h2 className="mb-2 text-xl font-bold">사진 상태</h2>
        <ul className="flex flex-wrap gap-2">
          {MODERATION_STATES.map((s) => (
            <li key={s} className="rounded-xl bg-ink px-3 py-2 text-lg">
              {STATUS_LABEL[s]} <strong>{o.byStatus[s]}</strong>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
