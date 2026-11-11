import { PhotoCard } from "@/components/admin/photo-card";
import { STATUS_LABEL } from "@/components/admin/labels";
import { kioskLabelMap, listStaffPhotos, PHOTO_WINDOWS, type PhotoWindow } from "@/lib/ops/admin";
import { requireStaff } from "@/lib/staff-auth/page";
import { isUuid } from "@/lib/server/validate";
import { MODERATION_STATES, type ModerationStatus } from "@/lib/storage/types";

export const dynamic = "force-dynamic";

/** Photo library with practical filters. Bounded (≤ 120 rows), newest first. */
export default async function PhotosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireStaff();
  const sp = await searchParams;
  const status =
    typeof sp.status === "string" && (MODERATION_STATES as readonly string[]).includes(sp.status)
      ? (sp.status as ModerationStatus)
      : "";
  const window =
    typeof sp.window === "string" && sp.window in PHOTO_WINDOWS
      ? (sp.window as PhotoWindow)
      : "24h";
  const kiosk = typeof sp.kiosk === "string" && isUuid(sp.kiosk) ? sp.kiosk : "";
  const session = typeof sp.session === "string" ? sp.session.trim() : "";
  const [photos, kiosks] = await Promise.all([
    listStaffPhotos({
      statuses: status ? [status] : undefined,
      window,
      kioskId: kiosk || undefined,
      sessionShort: session || undefined,
      limit: 120,
    }),
    kioskLabelMap(),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-3xl font-bold">사진</h1>
      <form className="admin-card flex flex-wrap items-end gap-3 p-4" action="/admin/photos">
        <label className="flex flex-col gap-1 text-base text-ink/75">
          상태
          <select name="status" defaultValue={status} className="admin-input">
            <option value="">전체</option>
            {MODERATION_STATES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-base text-ink/75">
          기간
          <select name="window" defaultValue={window} className="admin-input">
            {(Object.keys(PHOTO_WINDOWS) as PhotoWindow[]).map((w) => (
              <option key={w} value={w}>
                최근 {PHOTO_WINDOWS[w]}시간
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-base text-ink/75">
          키오스크
          <select name="kiosk" defaultValue={kiosk} className="admin-input">
            <option value="">전체</option>
            {[...kiosks].map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-base text-ink/75">
          세션 코드
          <input name="session" defaultValue={session} className="admin-input w-44 font-mono" />
        </label>
        <button type="submit" className="admin-btn admin-btn-primary">
          적용
        </button>
      </form>
      <p className="text-base text-ink/75">{photos.length}장 (최대 120장)</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="photo-library">
        {photos.map((p) => (
          <PhotoCard key={p.id} photo={p} />
        ))}
      </div>
    </div>
  );
}
