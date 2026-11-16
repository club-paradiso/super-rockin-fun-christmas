import { NextResponse } from "next/server";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { readJson, staffRoute } from "@/lib/server/staff-route";
import { isUuid } from "@/lib/server/validate";
import { getRemoteCameraStore, remoteCameraDisabled } from "@/lib/remote-camera/server";
import { isQualityMode, type CameraCommand } from "@/lib/remote-camera/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST {"action": "revoke" | "reconnect" | "disconnect" | "testCapture" | "setMode", "mode"?}.
 * Revoke ends the pairing at once (the phone's next call is refused). The others are commands the
 * camera page picks up on its next poll.
 */
export const POST = staffRoute<{ id: string }>(
  "admin_remote_camera_action",
  async (request, { staff }, { id }) => {
    if (remoteCameraDisabled() || !isUuid(id)) return jsonError(404, "not found");
    const body = await readJson<{ action?: unknown; mode?: unknown }>(request);
    const store = getRemoteCameraStore();
    const pairing = await store.get(id);
    if (!pairing) return jsonError(404, "not_found");
    const nowIso = new Date().toISOString();
    if (body?.action === "revoke") {
      const done = await store.revoke(id, staff.userId, nowIso);
      logEvent("camera_revoked", {
        kioskId: pairing.kioskId,
        pairingId: id,
        staffId: staff.userId,
      });
      return NextResponse.json({ ok: done }, { headers: NO_STORE });
    }
    if (pairing.revokedAt) return jsonError(409, "revoked");
    let cmd: CameraCommand;
    switch (body?.action) {
      case "reconnect":
      case "disconnect":
      case "testCapture":
        cmd = { name: body.action };
        break;
      case "setMode":
        if (!isQualityMode(body.mode)) return jsonError(400, "invalid mode");
        cmd = { name: "setMode", mode: body.mode };
        break;
      default:
        return jsonError(400, "unknown action");
    }
    await store.push({
      pairingId: id,
      kioskId: pairing.kioskId,
      from: "admin",
      to: "camera",
      message: { t: "cmd", cmd },
      nowIso,
    });
    logEvent("camera_command", {
      kioskId: pairing.kioskId,
      pairingId: id,
      command: cmd.name,
      staffId: staff.userId,
    });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  },
);
