import { NextResponse } from "next/server";
import { NO_STORE } from "@/lib/server/http";
import { hubRoute } from "@/lib/server/hub-route";
import { getPhotoService } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hub → cloud: phone photos waiting for the hub, oldest first (D66). Session ids, and the frame
 * the guest chose (D89), so the hub stores the photo with the same frame id.
 */
export const POST = hubRoute("hub_upload_list", async () => {
  const rows = await getPhotoService().mobileInbox(50);
  return NextResponse.json(
    {
      items: rows.map((r) => ({
        sessionId: r.sessionId,
        createdAt: r.createdAt,
        frameId: r.frameId,
      })),
    },
    { headers: NO_STORE },
  );
});
