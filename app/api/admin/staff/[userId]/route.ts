import { NextResponse } from "next/server";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { readJson, staffRoute } from "@/lib/server/staff-route";
import { isUuid } from "@/lib/server/validate";
import { getBackend } from "@/lib/storage/server";
import { hashPin, pinProblem } from "@/lib/staff-auth/pin";
import { getServerConfig } from "@/lib/server/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST {"active":false} / {"active":true} / {"displayName":"…"} — audited.
 * Hub only: POST {"pin":"123987"} sets a new PIN, which also ends that person's open sessions.
 */
export const POST = staffRoute<{ userId: string }>(
  "admin_staff_update",
  async (request, { staff }, { userId }) => {
    if (!isUuid(userId)) return jsonError(404, "not found");
    const body = await readJson<{ active?: unknown; displayName?: unknown; pin?: unknown }>(
      request,
    );
    if (typeof body?.pin === "string") {
      if (getServerConfig().staffAuth?.mode !== "pin") return jsonError(400, "PINs are hub only");
      const pin = body.pin.replace(/\s/g, "");
      const problem = pinProblem(pin);
      if (problem) return jsonError(400, problem);
      const backend = getBackend();
      if (!(await backend.staff.get(userId))) return jsonError(404, "not found");
      await backend.staff.setPin(userId, hashPin(pin), staff.userId);
      logEvent("staff_pin_reset", { userId, by: staff.userId });
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    }
    const active = typeof body?.active === "boolean" ? body.active : null;
    const displayName =
      typeof body?.displayName === "string" ? body.displayName.trim().slice(0, 64) || null : null;
    if (active === null && !displayName) return jsonError(400, "nothing to change");
    if (active === false && userId === staff.userId)
      return jsonError(409, "cannot deactivate yourself");
    const backend = getBackend();
    const existing = await backend.staff.get(userId);
    if (!existing) return jsonError(404, "not found");
    const member = await backend.staff.upsert(
      { userId, email: existing.email, displayName, active },
      staff.userId,
    );
    logEvent("staff_updated", { userId, active: member.active, by: staff.userId });
    return NextResponse.json({ member }, { headers: NO_STORE });
  },
);
