import Link from "next/link";
import { BackupButton } from "@/components/admin/backup-button";
import { EmergencyPanel } from "@/components/admin/emergency-panel";
import { WALL_CONFIG } from "@/config/wall";
import { wallOpen } from "@/lib/wall/hours";
import { STATUS_LABEL, ago, formatBytes, formatTime } from "@/components/admin/labels";
import { getOverview } from "@/lib/ops/admin";
import { requireStaff } from "@/lib/staff-auth/page";
import { MODERATION_STATES } from "@/lib/storage/types";

export const dynamic = "force-dynamic";

/** A line of the status list: what, a short note under it, and the figure on the right. */
function Row({
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
      <span className="min-w-0">
        <span className="block text-base">{label}</span>
        {sub && <span className="admin-help block">{sub}</span>}
      </span>
      <span className="shrink-0 text-base font-semibold tabular-nums" data-testid={testId}>
        {value}
        {href && (
          <span aria-hidden className="ml-1.5 font-normal text-ink/75">
            ›
          </span>
        )}
      </span>
    </>
  );
  const cls = "flex min-h-14 items-center justify-between gap-4 px-4 py-2.5";
  return href ? (
    <Link href={href} className={`${cls} active:bg-ink/5`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export default async function OverviewPage() {
  await requireStaff();
  const o = await getOverview();
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <h1 className="admin-h1">개요</h1>
      <EmergencyPanel
        settings={o.settings}
        wallStatus={wallOpen(o.settings, new Date(), WALL_CONFIG.timeZone)}
      />
      {/* The one number staff act on leads; the rest is a quiet list. */}
      <Link
        href="/admin/moderation"
        className="admin-card flex items-center justify-between gap-4 p-4 active:bg-ink/5"
      >
        <span>
          <span className="admin-help block">검수 대기</span>
          <span
            className="mt-1 block text-[44px] leading-none font-bold tabular-nums"
            data-testid="tile-pending"
          >
            {o.pendingCount}
          </span>
          <span className="admin-help mt-2 block">
            현장 {o.pendingBySource.booth} · 휴대폰 {o.pendingBySource.mobile}
          </span>
        </span>
        <span className="admin-btn admin-btn-primary shrink-0">검수하기</span>
      </Link>
      <section className="admin-card divide-y divide-ink/10" aria-label="현황">
        <Row
          label="키오스크"
          value={`${o.kiosks.online} 온라인`}
          sub={`지연 ${o.kiosks.stale} · 오프라인 ${o.kiosks.offline}`}
          href="/admin/kiosks"
          testId="tile-kiosks"
        />
        <Row
          label="키오스크 전송 대기"
          value={`${o.kiosks.queueDepth}건`}
          sub="온라인·지연 키오스크 보고 기준"
        />
        <Row
          label="보관 중 사진"
          value={`${o.storedCount}장`}
          sub={`${formatBytes(o.storedBytes)} (DB 기록 기준)`}
        />
      </section>
      {o.cloud && (
        <section className="admin-card p-4" data-testid="cloud-status">
          <h2 className="admin-h2 mb-2">QR 서버 (인터넷)</h2>
          {o.cloud.pendingUploads === 0 && o.cloud.pendingDeletes === 0 ? (
            <p className="text-base">밀린 일이 없어요.</p>
          ) : (
            <p className="text-base">
              <span className="text-danger">
                QR 대기 {o.cloud.pendingUploads}건 · 삭제 대기 {o.cloud.pendingDeletes}건
              </span>
              <br />
              <span className="admin-help">
                인터넷이 돌아오면 자동으로 보내요. 사진은 이 노트북에 안전하게 있어요.
                {o.cloud.lastError && ` 마지막 오류: ${o.cloud.lastError}`}
              </span>
            </p>
          )}
        </section>
      )}
      {o.inbox && (
        <section className="admin-card p-4" data-testid="inbox-status">
          <h2 className="admin-h2 mb-2">휴대폰 사진 받기 (인터넷)</h2>
          {o.inbox.lastError ? (
            <p className="text-base">
              <span className="text-danger">인터넷 사진함에 연결하지 못했어요.</span>
              <br />
              <span className="admin-help">
                방문객이 보낸 사진은 사진함에서 기다려요. 연결되면 자동으로 가져와요. 마지막 오류:{" "}
                {o.inbox.lastError}
              </span>
            </p>
          ) : (
            <p className="text-base">
              {o.inbox.lastPullAt
                ? `정상 · 마지막 확인 ${formatTime(o.inbox.lastPullAt)} · 허브를 켠 뒤 받은 사진 ${o.inbox.imported}장`
                : "아직 확인 전이에요 (허브가 켜진 뒤 15초 안에 확인해요)."}
            </p>
          )}
        </section>
      )}
      {o.ops && <OpsSection ops={o.ops} />}
      <section className="admin-card p-4">
        <h2 className="admin-h2 mb-2">마지막 자동 정리</h2>
        {o.lastRetention ? (
          <p className="text-base">
            {formatTime(o.lastRetention.ranAt)} ({ago(o.lastRetention.ranAt)}) · 삭제{" "}
            {o.lastRetention.deleted}건
            {o.lastRetention.failed > 0 && (
              <span className="text-danger"> · 실패 {o.lastRetention.failed}건</span>
            )}
          </p>
        ) : (
          <p className="text-base text-ink/75">
            아직 실행 기록이 없어요 (
            {o.retention.where === "hub" ? "켜진 동안 10분마다" : "매일 03:17 KST"} 실행).
          </p>
        )}
        {o.retention.where === "hub" ? (
          <ul className="admin-help mt-2 flex flex-col gap-1" data-testid="retention-rules">
            <li>
              미디어월에 안 나간 사진(동의 안 함·거절·검수 대기): 촬영 {o.retention.unpostedHours}
              시간 뒤 삭제
            </li>
            <li>
              미디어월 사진:{" "}
              {o.retention.wallUntil
                ? `${formatTime(o.retention.wallUntil)}에 삭제`
                : `행사 종료 시각이 설정되지 않아 촬영 ${o.retention.days}일 뒤 삭제`}
            </li>
            <li>어떤 사진이든 촬영 {o.retention.days}일을 넘기지 않음</li>
          </ul>
        ) : (
          <p className="admin-help mt-2">사진은 촬영 {o.retention.days}일 뒤 삭제돼요.</p>
        )}
      </section>
      <section className="admin-card p-4">
        <h2 className="admin-h2 mb-3">사진 상태</h2>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-1 text-base">
          {MODERATION_STATES.map((s) => (
            <li key={s} className="flex items-baseline justify-between gap-3">
              <span>{STATUS_LABEL[s]}</span>
              <strong className="tabular-nums">{o.byStatus[s]}</strong>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function OpsSection({ ops }: { ops: NonNullable<Awaited<ReturnType<typeof getOverview>>["ops"]> }) {
  const { backup, disk } = ops;
  const stale = backup.stale;
  const low = (free: number | null) => free !== null && free < disk.warnBelow;
  const warn =
    !backup.configured || !!backup.error || stale || low(disk.dataFree) || low(disk.backupFree);
  return (
    <section className="admin-card p-4" data-testid="ops-status">
      <h2 className="admin-h2 mb-2">
        백업 · 저장 공간 {warn && <span className="text-danger">· 확인 필요</span>}
      </h2>
      <ul className="flex flex-col gap-1 text-base">
        <li data-testid="backup-status">
          {!backup.configured ? (
            <span className="text-danger">
              백업 위치(HUB_BACKUP_DIR)가 설정되지 않았어요. 노트북이 고장 나면 사진을 잃어요.
            </span>
          ) : backup.lastAt ? (
            <span className={stale || backup.error ? "text-danger" : undefined}>
              마지막 백업 {formatTime(backup.lastAt)} ({ago(backup.lastAt)}) · 사진 파일{" "}
              {backup.files}개 · {backup.everyMinutes}분마다
            </span>
          ) : (
            <span className="text-danger">아직 백업한 적이 없어요.</span>
          )}
        </li>
        {backup.error && (
          <li className="text-danger" data-testid="backup-error">
            백업 실패 {formatTime(backup.error.at)}: USB가 꽂혀 있는지 확인해 주세요. (
            {backup.error.message})
          </li>
        )}
        <li className={low(disk.dataFree) ? "text-danger" : undefined} data-testid="disk-status">
          노트북 남은 공간: {disk.dataFree === null ? "알 수 없음" : formatBytes(disk.dataFree)}
          {low(disk.dataFree) && " · 부족해요. 기술 담당에게 연락하세요"}
        </li>
        {backup.configured && (
          <li className={low(disk.backupFree) ? "text-danger" : undefined}>
            USB 남은 공간:{" "}
            {disk.backupFree === null ? "USB를 찾을 수 없어요" : formatBytes(disk.backupFree)}
            {low(disk.backupFree) && " · 부족해요"}
          </li>
        )}
      </ul>
      {backup.configured && (
        <div className="mt-3">
          <BackupButton />
        </div>
      )}
    </section>
  );
}
