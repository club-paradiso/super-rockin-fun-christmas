import Link from "next/link";
import { PhotoCard } from "@/components/admin/photo-card";
import type { PhotoSource } from "@/config/mobile";
import { pendingQueue } from "@/lib/ops/admin";
import { requireStaff } from "@/lib/staff-auth/page";

export const dynamic = "force-dynamic";

const FILTERS: { key: PhotoSource | "all"; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "booth", label: "현장 촬영" },
  { key: "mobile", label: "휴대폰 사진" },
];

/**
 * The main job: consented photos waiting for a human decision, oldest first. Booth photos and
 * guests' own phone photos (D66) share one queue and one set of rules; the filter only narrows it.
 */
export default async function ModerationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireStaff();
  const { source } = await searchParams;
  const filter: PhotoSource | undefined =
    source === "mobile" ? "mobile" : source === "booth" ? "booth" : undefined;
  const queue = await pendingQueue(60, filter);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-3xl font-bold">검수 대기 {queue.length}건</h1>
        <p className="text-base text-mist">미디어월 동의 + 검수 대기 · 오래된 순</p>
      </div>
      <nav className="flex flex-wrap gap-2" aria-label="사진 출처">
        {FILTERS.map((f) => {
          const active = (filter ?? "all") === f.key;
          return (
            <Link
              key={f.key}
              href={f.key === "all" ? "/admin/moderation" : `/admin/moderation?source=${f.key}`}
              aria-current={active ? "page" : undefined}
              data-testid={`queue-filter-${f.key}`}
              className={`admin-btn min-h-12 ${active ? "admin-btn-primary" : "admin-btn-quiet"}`}
            >
              {f.label}
            </Link>
          );
        })}
      </nav>
      {queue.length === 0 ? (
        <p className="admin-card p-8 text-center text-xl text-mist" data-testid="queue-empty">
          검수할 사진이 없어요.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="moderation-queue">
          {queue.map((p) => (
            <PhotoCard key={p.id} photo={p} primaryOnly />
          ))}
        </div>
      )}
    </div>
  );
}
