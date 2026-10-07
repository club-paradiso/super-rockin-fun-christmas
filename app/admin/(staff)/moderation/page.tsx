import { PhotoCard } from "@/components/admin/photo-card";
import { pendingQueue } from "@/lib/ops/admin";
import { requireStaff } from "@/lib/staff-auth/page";

export const dynamic = "force-dynamic";

/** The main job: consented photos waiting for a human decision, oldest first. */
export default async function ModerationPage() {
  await requireStaff();
  const queue = await pendingQueue(60);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-3xl font-bold">검수 대기 {queue.length}건</h1>
        <p className="text-base text-mist">미디어월 동의 + 검수 대기 · 오래된 순</p>
      </div>
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
