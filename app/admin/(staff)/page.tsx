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
      <p className="text-base text-ink/75">{label}</p>
      <p className="mt-1 text-4xl font-bold" data-testid={testId}>
        {value}
      </p>
      {sub && <p className="mt-1 text-base text-ink/75">{sub}</p>}
    </>
  );
  return href ? (
    <Link href={href} className="admin-card block p-4 hover:border-accent/60">
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
      <EmergencyPanel
        settings={o.settings}
        wallStatus={wallOpen(o.settings, new Date(), WALL_CONFIG.timeZone)}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          label="검수 대기"
          value={`${o.pendingCount}`}
          sub={`현장 ${o.pendingBySource.booth} · 휴대폰 ${o.pendingBySource.mobile}`}
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
      {o.cloud && (
        <section className="admin-card p-4" data-testid="cloud-status">
          <h2 className="mb-2 text-xl font-bold">QR 서버 (인터넷)</h2>
          {o.cloud.pendingUploads === 0 && o.cloud.pendingDeletes === 0 ? (
            <p className="text-lg">밀린 일이 없어요.</p>
          ) : (
            <p className="text-lg">
              <span className="text-danger">
                QR 대기 {o.cloud.pendingUploads}건 · 삭제 대기 {o.cloud.pendingDeletes}건
              </span>
              <br />
              <span className="text-base text-ink/75">
                인터넷이 돌아오면 자동으로 보내요. 사진은 이 노트북에 안전하게 있어요.
                {o.cloud.lastError && ` 마지막 오류: ${o.cloud.lastError}`}
              </span>
            </p>
          )}
        </section>
      )}
      {o.inbox && (
        <section className="admin-card p-4" data-testid="inbox-status">
          <h2 className="mb-2 text-xl font-bold">휴대폰 사진 받기 (인터넷)</h2>
          {o.inbox.lastError ? (
            <p className="text-lg">
              <span className="text-danger">인터넷 사진함에 연결하지 못했어요.</span>
              <br />
              <span className="text-base text-ink/75">
                방문객이 보낸 사진은 사진함에서 기다려요. 연결되면 자동으로 가져와요. 마지막 오류:{" "}
                {o.inbox.lastError}
              </span>
            </p>
          ) : (
            <p className="text-lg">
              {o.inbox.lastPullAt
                ? `정상 · 마지막 확인 ${formatTime(o.inbox.lastPullAt)} · 허브를 켠 뒤 받은 사진 ${o.inbox.imported}장`
                : "아직 확인 전이에요 (허브가 켜진 뒤 15초 안에 확인해요)."}
            </p>
          )}
        </section>
      )}
      {o.ops && <OpsSection ops={o.ops} />}
      <section className="admin-card p-4">
        <h2 className="mb-2 text-xl font-bold">마지막 자동 정리</h2>
        {o.lastRetention ? (
          <p className="text-lg">
            {formatTime(o.lastRetention.ranAt)} ({ago(o.lastRetention.ranAt)}) · 삭제{" "}
            {o.lastRetention.deleted}건
            {o.lastRetention.failed > 0 && (
              <span className="text-danger"> · 실패 {o.lastRetention.failed}건</span>
            )}
          </p>
        ) : (
          <p className="text-lg text-ink/75">
            아직 실행 기록이 없어요 (
            {o.retention.where === "hub" ? "켜진 동안 10분마다" : "매일 03:17 KST"} 실행).
          </p>
        )}
        {o.retention.where === "hub" ? (
          <ul className="mt-2 text-base text-ink/75" data-testid="retention-rules">
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
          <p className="mt-2 text-base text-ink/75">
            사진은 촬영 {o.retention.days}일 뒤 삭제돼요.
          </p>
        )}
      </section>
      <section className="admin-card p-4">
        <h2 className="mb-2 text-xl font-bold">사진 상태</h2>
        <ul className="flex flex-wrap gap-2">
          {MODERATION_STATES.map((s) => (
            <li key={s} className="rounded-lg bg-backdrop px-3 py-2 text-lg">
              {STATUS_LABEL[s]} <strong>{o.byStatus[s]}</strong>
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
      <h2 className="mb-2 text-xl font-bold">
        백업 · 저장 공간 {warn && <span className="text-danger">· 확인 필요</span>}
      </h2>
      <ul className="flex flex-col gap-1 text-lg">
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
