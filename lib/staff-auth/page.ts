import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getStaffForPage, type StaffAuth } from "./server";

/** Per-request cached staff check for Server Components. */
export const currentStaff = cache(async (): Promise<StaffAuth> => getStaffForPage());

/**
 * Every staff page calls this (layouts are not re-rendered on every navigation, so the layout
 * check alone is not enough). Unauthenticated → login; not allowlisted → the layout's notice.
 */
export async function requireStaff() {
  const auth = await currentStaff();
  if (!auth.ok) {
    if (auth.reason === "unauthenticated") redirect("/admin/login");
    redirect("/admin/login?denied=" + auth.reason);
  }
  return auth.staff;
}
