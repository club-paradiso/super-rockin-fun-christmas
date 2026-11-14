import { EnrollmentCodeCreator, KioskManager } from "@/components/admin/kiosk-manager";
import { formatTime } from "@/components/admin/labels";
import { toStaffKioskView } from "@/lib/ops/admin";
import { ONLINE_WITHIN_MS, STALE_WITHIN_MS } from "@/lib/ops/kiosks";
import { requireStaff } from "@/lib/staff-auth/page";
import { getBackend } from "@/lib/storage/server";

export const dynamic = "force-dynamic";

export default async function KiosksPage() {
  await requireStaff();
  const backend = getBackend();
  const [kiosks, codes] = await Promise.all([
    backend.kiosks.list(),
    backend.enrollmentCodes.listRecent(10),
  ]);
  const views = kiosks
    .map((k) => toStaffKioskView(k))
    .sort((a, b) => Number(!!a.revokedAt) - Number(!!b.revokedAt));
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <h1 className="admin-h1">키오스크</h1>
      <p className="text-base text-ink/75">
        온라인: {ONLINE_WITHIN_MS / 60_000}분 안에 신호 · 응답 지연: {STALE_WITHIN_MS / 60_000}분 안
        · 그 이상은 오프라인
      </p>
      <KioskManager kiosks={views} />
      <EnrollmentCodeCreator />
      {codes.length > 0 && (
        <section className="admin-card p-4">
          <h2 className="admin-h2 mb-2">최근 등록 코드</h2>
          <ul className="flex flex-col gap-1 text-base">
            {codes.map((c) => (
              <li key={c.id} className="flex flex-wrap justify-between gap-2">
                <span>{c.label}</span>
                <span className="text-ink/75">
                  {c.usedAt
                    ? `사용됨 ${formatTime(c.usedAt)}`
                    : new Date(c.expiresAt) < new Date()
                      ? "만료됨"
                      : `${formatTime(c.expiresAt)}까지 유효`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
