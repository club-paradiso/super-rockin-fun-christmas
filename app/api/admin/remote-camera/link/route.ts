import { NextResponse } from "next/server";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { publicOrigin } from "@/lib/server/public-url";
import { getServerConfig } from "@/lib/server/env";
import { readJson, staffRoute } from "@/lib/server/staff-route";
import { isUuid } from "@/lib/server/validate";
import { getBackend } from "@/lib/storage/server";
import { issuePairingCode, remoteCameraDisabled } from "@/lib/remote-camera/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST {"kioskId"} → a single-use pairing code and the address the iPhone opens (10 minutes). */
export const POST = staffRoute("admin_remote_camera_pair", async (request, { staff }) => {
  if (remoteCameraDisabled()) return jsonError(404, "not found");
  const body = await readJson<{ kioskId?: unknown }>(request);
  if (!isUuid(body?.kioskId)) return jsonError(400, "kioskId required");
  const kiosk = await getBackend().kiosks.get(body.kioskId);
  if (!kiosk || kiosk.revokedAt) return jsonError(404, "not_found");
  const issued = await issuePairingCode(kiosk.id, staff.userId);
  const origin = publicOrigin(getServerConfig(), request);
  return NextResponse.json(
    {
      code: issued.display,
      expiresAt: issued.expiresAt,
      // The code rides in the fragment-free query once; the page removes it from the address bar.
      url: `${origin}/camera/remote?code=${issued.code}`,
      secure: origin.startsWith("https://"),
      kioskLabel: kiosk.label,
    },
    { headers: NO_STORE },
  );
});
