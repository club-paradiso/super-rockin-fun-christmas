import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  ENROLLMENT_CODE_TTL_MINUTES,
  generateEnrollmentCode,
  hashEnrollmentCode,
  normalizeEnrollmentCode,
} from "@/lib/ops/enrollment-code";
import { cleanKioskLabel } from "@/lib/ops/kiosks";
import { NO_STORE, jsonError } from "@/lib/server/http";
import { logEvent } from "@/lib/server/log";
import { readJson, staffRoute } from "@/lib/server/staff-route";
import { getBackend } from "@/lib/storage/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recent codes (never the codes themselves — only their status). */
export const GET = staffRoute("admin_enrollment_codes", async () => {
  const codes = (await getBackend().enrollmentCodes.listRecent(20)).map((c) => ({
    id: c.id,
    label: c.label,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    usedAt: c.usedAt,
    usedKioskId: c.usedKioskId,
  }));
  return NextResponse.json({ codes }, { headers: NO_STORE });
});

/**
 * POST {"label":"본당 입구"} → a one-time code shown ONCE to staff, valid 15 minutes. Only its
 * hash is stored. Audited.
 */
export const POST = staffRoute("admin_enrollment_code_create", async (request, { staff }) => {
  const body = await readJson<{ label?: unknown }>(request);
  const label = cleanKioskLabel(body?.label);
  if (!label) return jsonError(400, "label required");
  const code = generateEnrollmentCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ENROLLMENT_CODE_TTL_MINUTES * 60_000).toISOString();
  const row = await getBackend().enrollmentCodes.create({
    id: randomUUID(),
    codeHash: hashEnrollmentCode(normalizeEnrollmentCode(code)!),
    label,
    createdBy: staff.userId,
    createdAt: now.toISOString(),
    expiresAt,
  });
  logEvent("enrollment_code_created", { codeId: row.id, staffId: staff.userId });
  return NextResponse.json(
    { id: row.id, code, label, expiresAt },
    { status: 201, headers: NO_STORE },
  );
});
