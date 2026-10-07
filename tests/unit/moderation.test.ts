import { describe, expect, it } from "vitest";
import { availableActions, isWallEligible, planModeration } from "@/lib/ops/moderation";
import type { ModerationStatus } from "@/lib/storage/types";

const row = (
  moderationStatus: ModerationStatus,
  wallConsent = true,
  deletedAt: string | null = null,
) => ({
  moderationStatus,
  wallConsent,
  deletedAt,
});

describe("moderation state machine", () => {
  it.each([
    ["PENDING", "approve", "APPROVED"],
    ["PENDING", "reject", "REJECTED"],
    ["APPROVED", "hide", "HIDDEN"],
    ["HIDDEN", "unhide", "APPROVED"],
    ["REJECTED", "reopen", "PENDING"],
    ["NONE", "delete", "DELETED"],
    ["APPROVED", "delete", "DELETED"],
  ] as const)("%s --%s--> %s", (from, action, to) => {
    expect(planModeration(row(from), action)).toEqual({ ok: true, from, to });
  });

  it.each([
    ["NONE", "approve"],
    ["APPROVED", "approve"],
    ["REJECTED", "approve"],
    ["HIDDEN", "reject"],
    ["PENDING", "hide"],
    ["APPROVED", "unhide"],
    ["PENDING", "reopen"],
  ] as const)("refuses %s --%s", (from, action) => {
    expect(planModeration(row(from), action)).toEqual({ ok: false, reason: "invalid_transition" });
  });

  it("never approves a photo without wall consent", () => {
    expect(planModeration(row("PENDING", false), "approve")).toEqual({
      ok: false,
      reason: "no_consent",
    });
    expect(planModeration(row("HIDDEN", false), "unhide")).toEqual({
      ok: false,
      reason: "no_consent",
    });
    expect(planModeration(row("REJECTED", false), "reopen")).toEqual({
      ok: false,
      reason: "no_consent",
    });
  });

  it("DELETED is terminal for every action", () => {
    for (const a of ["approve", "reject", "hide", "unhide", "reopen", "delete"] as const) {
      expect(planModeration(row("DELETED"), a)).toEqual({ ok: false, reason: "deleted" });
    }
    expect(availableActions(row("DELETED"))).toEqual([]);
  });

  it("offers only valid actions", () => {
    expect(availableActions(row("PENDING"))).toEqual(["approve", "reject", "delete"]);
    expect(availableActions(row("APPROVED"))).toEqual(["hide", "delete"]);
    expect(availableActions(row("NONE", false))).toEqual(["delete"]);
  });

  it("only APPROVED + consent + not deleted is wall-eligible", () => {
    expect(isWallEligible(row("APPROVED"))).toBe(true);
    expect(isWallEligible(row("APPROVED", false))).toBe(false);
    expect(isWallEligible(row("HIDDEN"))).toBe(false);
    expect(isWallEligible(row("PENDING"))).toBe(false);
    expect(isWallEligible(row("APPROVED", true, "2026-12-24T00:00:00Z"))).toBe(false);
  });
});
