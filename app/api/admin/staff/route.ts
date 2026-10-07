import { NextResponse } from "next/server";
import { addStaffMember } from "@/lib/ops/staff-admin";
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

/** POST {"email","displayName"} — add (or re-activate) a staff member. Audited. */
export const POST = staffRoute("admin_staff_add", async (request, { staff }) => {
  const body = await readJson<{ email?: unknown; displayName?: unknown }>(request);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const displayName =
    typeof body?.displayName === "string" ? body.displayName.trim().slice(0, 64) : "";
  if (!isEmail(email) || !displayName) return jsonError(400, "email and displayName required");
  const member = await addStaffMember(email, displayName, staff.userId);
  logEvent("staff_added", { userId: member.userId, by: staff.userId });
  return NextResponse.json({ member }, { status: 201, headers: NO_STORE });
});
