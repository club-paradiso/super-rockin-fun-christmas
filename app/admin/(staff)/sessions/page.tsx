import Link from "next/link";
import { PhotoCard } from "@/components/admin/photo-card";
import { listStaffPhotos, PHOTO_WINDOWS, type PhotoWindow } from "@/lib/ops/admin";
import { requireStaff } from "@/lib/staff-auth/page";

export const dynamic = "force-dynamic";

const WINDOWS: PhotoWindow[] = ["1h", "6h", "12h", "24h"];

/**
 * Recovery for guests whose QR did not appear or got lost: recent sessions only (default 6 h),
 * findable by time, kiosk or the short session code shown on the kiosk QR screen.
 */
export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireStaff();
  const sp = await searchParams;
  const window =
    typeof sp.window === "string" && sp.window in PHOTO_WINDOWS ? (sp.window as PhotoWindow) : "6h";
  const session = typeof sp.session === "string" ? sp.session.trim() : "";
  const photos = await listStaffPhotos({
    window,
    sessionShort: session || undefined,
    statuses: ["NONE", "PENDING", "APPROVED", "REJECTED", "HIDDEN"],
    limit: 60,
  });
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-3xl font-bold">최근 세션</h1>
      <p className="text-lg text-mist">
        QR이 안 나왔거나 잃어버린 방문객을 도울 때 쓰세요. 최근 세션만 보여요.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {WINDOWS.map((w) => (
          <Link
            key={w}
            href={`/admin/sessions?window=${w}`}
            className={`admin-btn ${w === window ? "admin-btn-primary" : "admin-btn-quiet"}`}
          >
            최근 {PHOTO_WINDOWS[w]}시간
          </Link>
        ))}
        <form className="flex gap-2" action="/admin/sessions">
          <input type="hidden" name="window" value={window} />
          <input
            name="session"
            defaultValue={session}
            placeholder="세션 코드 (예: 3f2a9c1d)"
            aria-label="세션 코드"
            className="admin-input w-56 font-mono"
          />
          <button type="submit" className="admin-btn admin-btn-quiet">
            찾기
          </button>
        </form>
      </div>
      {photos.length === 0 ? (
        <p className="admin-card p-8 text-center text-xl text-mist">이 기간에 세션이 없어요.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="session-list">
          {photos.map((p) => (
            <PhotoCard key={p.id} photo={p} showRecovery />
          ))}
        </div>
      )}
    </div>
  );
}
