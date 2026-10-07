import { NextResponse } from "next/server";
import { toStaffKioskView } from "@/lib/ops/admin";
import { cleanKioskLabel } from "@/lib/ops/kiosks";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { readJson, staffRoute } from "@/lib/server/staff-route";
import { isUuid } from "@/lib/server/validate";
import { getBackend } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST {"action":"rename","label":"…"} | {"action":"revoke"} — audited, revoke is immediate. */
export const POST = staffRoute<{ id: string }>(
  "admin_kiosk_update",
  async (request, { staff }, { id }) => {
    if (!isUuid(id)) return jsonError(404, "not found");
    const body = await readJson<{ action?: unknown; label?: unknown }>(request);
    let change: { label?: string; revoke?: boolean };
    if (body?.action === "rename") {
      const label = cleanKioskLabel(body.label);
      if (!label) return jsonError(400, "label required");
      change = { label };
    } else if (body?.action === "revoke") {
      change = { revoke: true };
    } else {
      return jsonError(400, "unknown action");
    }
    const kiosk = await getBackend().kiosks.update(id, change, staff.userId);
    if (!kiosk) return jsonError(404, "not found");
    logEvent("kiosk_updated", { kioskId: id, action: String(body.action), staffId: staff.userId });
    return NextResponse.json({ kiosk: toStaffKioskView(kiosk) }, { headers: NO_STORE });
  },
);
