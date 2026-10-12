import "server-only";
import { randomUUID } from "node:crypto";
import { hashPin } from "@/lib/staff-auth/pin";
import { getServerConfig } from "@/lib/server/env";
import { createServiceClient } from "@/lib/storage/supabase-backend";
import { getBackend } from "@/lib/storage/server";
import type { StaffMember } from "@/lib/storage/types";

/**
 * Add a staff member: make sure a Supabase Auth user exists for the email (created server-side,
 * already confirmed — public signup stays disabled), then add the allowlist row (audited).
 */
export async function addStaffMember(
  email: string,
  displayName: string,
  actorId: string | null,
): Promise<StaffMember> {
  const config = getServerConfig();
  if (!config.supabase) throw new Error("staff management needs the Supabase backend");
  const admin = createServiceClient(config.supabase).auth.admin;
  const normalized = email.trim().toLowerCase();

  let userId: string | null = null;
  const created = await admin.createUser({ email: normalized, email_confirm: true });
  if (created.data.user) {
    userId = created.data.user.id;
  } else {
    // Already registered: find it (event scale — a few pages at most).
    for (let page = 1; page <= 20 && !userId; page++) {
      const { data, error } = await admin.listUsers({ page, perPage: 200 });
      if (error) throw error;
      userId = data.users.find((u) => u.email?.toLowerCase() === normalized)?.id ?? null;
      if (data.users.length < 200) break;
    }
  }
  if (!userId)
    throw new Error(`could not create or find auth user: ${created.error?.message ?? "unknown"}`);
  return getBackend().staff.upsert(
    { userId, email: normalized, displayName, active: true },
    actorId,
  );
}

/**
 * Hub (FTL_ROLE=hub): add a staff member who signs in with name + PIN. No email or other contact
 * details are stored. Both writes are audited (`add_staff`, `set_staff_pin`).
 */
export async function addPinStaffMember(
  displayName: string,
  pin: string,
  actorId: string | null,
): Promise<StaffMember> {
  const staff = getBackend().staff;
  const member = await staff.upsert(
    { userId: randomUUID(), email: "", displayName, active: true },
    actorId,
  );
  await staff.setPin(member.userId, hashPin(pin), actorId);
  return member;
}
