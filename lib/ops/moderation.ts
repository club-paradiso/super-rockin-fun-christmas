import type { ModerationStatus, PhotoRow } from "@/lib/storage/types";

/**
 * The one place moderation transitions are defined. Enforced server-side by PhotoService; the
 * database additionally enforces "APPROVED needs consent" and "DELETED is terminal".
 *
 *   NONE ──(guest YES)──► PENDING ──approve──► APPROVED ──hide──► HIDDEN
 *    ▲                      │  ▲                  ▲                  │
 *    └──(guest NO)──────────┘  └─reopen─ REJECTED  └──────unhide──────┘
 *                           └──reject──► REJECTED
 *   any state ──delete──► DELETED (terminal; image removed)
 */
export const MODERATION_ACTIONS = [
  "approve",
  "reject",
  "hide",
  "unhide",
  "reopen",
  "delete",
] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

interface Rule {
  from: ModerationStatus[];
  to: ModerationStatus;
  needsConsent: boolean;
}

const RULES: Record<Exclude<ModerationAction, "delete">, Rule> = {
  approve: { from: ["PENDING"], to: "APPROVED", needsConsent: true },
  reject: { from: ["PENDING"], to: "REJECTED", needsConsent: false },
  hide: { from: ["APPROVED"], to: "HIDDEN", needsConsent: false },
  unhide: { from: ["HIDDEN"], to: "APPROVED", needsConsent: true },
  // Undo a mistaken rejection: back to the queue, not straight to the wall.
  reopen: { from: ["REJECTED"], to: "PENDING", needsConsent: true },
};

export type ModerationPlan =
  | { ok: true; from: ModerationStatus; to: ModerationStatus }
  | { ok: false; reason: "invalid_transition" | "no_consent" | "deleted" };

export function planModeration(
  row: Pick<PhotoRow, "moderationStatus" | "wallConsent" | "deletedAt">,
  action: ModerationAction,
): ModerationPlan {
  const from = row.moderationStatus;
  if (from === "DELETED" || row.deletedAt) return { ok: false, reason: "deleted" };
  if (action === "delete") return { ok: true, from, to: "DELETED" };
  const rule = RULES[action];
  if (!rule.from.includes(from)) return { ok: false, reason: "invalid_transition" };
  if (rule.needsConsent && !row.wallConsent) return { ok: false, reason: "no_consent" };
  return { ok: true, from, to: rule.to };
}

/** Actions a staff UI should offer for a photo (delete is always offered until deleted). */
export function availableActions(
  row: Pick<PhotoRow, "moderationStatus" | "wallConsent" | "deletedAt">,
): ModerationAction[] {
  return MODERATION_ACTIONS.filter((a) => planModeration(row, a).ok);
}

/** Photos the Phase 4 wall may show. */
export function isWallEligible(
  row: Pick<PhotoRow, "moderationStatus" | "wallConsent" | "deletedAt">,
): boolean {
  return row.moderationStatus === "APPROVED" && row.wallConsent && row.deletedAt === null;
}

/**
 * Photos an ANONYMOUS viewer of the wall address may be sent (D86): wall-eligible, and the
 * guest's consent covered the public address. A photo taken before the public wall existed, or
 * while it was switched off, never qualifies, whatever staff do to it later.
 */
export function isPublicWallEligible(
  row: Pick<PhotoRow, "moderationStatus" | "wallConsent" | "wallPublic" | "deletedAt">,
): boolean {
  return isWallEligible(row) && row.wallPublic === true;
}
