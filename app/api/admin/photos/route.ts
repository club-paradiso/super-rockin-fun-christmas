import { NextResponse } from "next/server";
import { listStaffPhotos, PHOTO_WINDOWS, type PhotoWindow } from "@/lib/ops/admin";
import { NO_STORE } from "@/lib/server/http";
import { staffRoute } from "@/lib/server/staff-route";
import { isUuid } from "@/lib/server/validate";
import { MODERATION_STATES, type ModerationStatus } from "@/lib/storage/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET ?status=PENDING,APPROVED&window=6h&kiosk=<uuid>&session=3f2a9c&source=mobile&limit=60 */
export const GET = staffRoute("admin_photos", async (request) => {
  const q = new URL(request.url).searchParams;
  const statuses = q
    .get("status")
    ?.split(",")
    .filter((s): s is ModerationStatus => (MODERATION_STATES as readonly string[]).includes(s));
  const window = q.get("window");
  const kiosk = q.get("kiosk");
  const photos = await listStaffPhotos({
    statuses: statuses?.length ? statuses : undefined,
    window: window && window in PHOTO_WINDOWS ? (window as PhotoWindow) : undefined,
    kioskId: isUuid(kiosk) ? kiosk : undefined,
    sessionShort: q.get("session") ?? undefined,
    source:
      q.get("source") === "mobile" ? "mobile" : q.get("source") === "booth" ? "booth" : undefined,
    limit: Number(q.get("limit")) || undefined,
  });
  return NextResponse.json({ photos }, { headers: NO_STORE });
});
