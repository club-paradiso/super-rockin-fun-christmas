import { NextResponse } from "next/server";
import { addPinStaffMember, addStaffMember } from "@/lib/ops/staff-admin";
import { pinProblem } from "@/lib/staff-auth/pin";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { readJson, staffRoute } from "@/lib/server/staff-route";
import { isEmail } from "@/lib/server/validate";
import { getBackend } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = staffRoute("admin_staff_list", async () =>
  NextResponse.json({ staff: await getBackend().staff.list() }, { headers: NO_STORE }),
);

/**
 * Add a staff member. Audited.
 * - cloud: POST {"email","displayName"} (adds or re-activates; they sign in with email codes)
 * - hub:   POST {"displayName","pin"} (no email or other contact details)
 */
export const POST = staffRoute("admin_staff_add", async (request, { staff }) => {
  const body = await readJson<{ email?: unknown; displayName?: unknown; pin?: unknown }>(request);
  const displayName =
    typeof body?.displayName === "string" ? body.displayName.trim().slice(0, 64) : "";
  if (getServerConfig().staffAuth?.mode === "pin") {
    const pin = typeof body?.pin === "string" ? body.pin.replace(/\s/g, "") : "";
    if (!displayName) return jsonError(400, "displayName and pin required");
    const problem = pinProblem(pin);
    if (problem) return jsonError(400, problem);
    const member = await addPinStaffMember(displayName, pin, staff.userId);
    logEvent("staff_added", { userId: member.userId, by: staff.userId, via: "pin" });
    return NextResponse.json({ member }, { status: 201, headers: NO_STORE });
  }
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!isEmail(email) || !displayName) return jsonError(400, "email and displayName required");
  const member = await addStaffMember(email, displayName, staff.userId);
  logEvent("staff_added", { userId: member.userId, by: staff.userId });
  return NextResponse.json({ member }, { status: 201, headers: NO_STORE });
});
