import { NextResponse } from "next/server";
import { NO_STORE } from "@/lib/server/http";
import { staffRoute } from "@/lib/server/staff-route";
import { getBackend } from "@/lib/storage/server";
import {
  getIceConfig,
  getRemoteCameraStore,
  purgeRemoteCameraSoon,
  remoteCameraDisabled,
} from "@/lib/remote-camera/server";
import { toStaffCameraView } from "@/lib/remote-camera/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Staff: every paired camera with live state, plus the kiosks that could get one. */
export const GET = staffRoute("admin_remote_camera_list", async () => {
  if (remoteCameraDisabled()) return NextResponse.json({ disabled: true }, { headers: NO_STORE });
  purgeRemoteCameraSoon();
  const [pairings, kiosks] = await Promise.all([
    getRemoteCameraStore().list(),
    getBackend().kiosks.list(),
  ]);
  return NextResponse.json(
    {
      disabled: false,
      cameras: pairings.map((p) =>
        toStaffCameraView(
          p,
          kiosks.find((k) => k.id === p.kioskId)?.label ?? "알 수 없는 키오스크",
        ),
      ),
      kiosks: kiosks.filter((k) => !k.revokedAt).map((k) => ({ id: k.id, label: k.label })),
      iceProblem: getIceConfig().problem,
    },
    { headers: NO_STORE },
  );
});
