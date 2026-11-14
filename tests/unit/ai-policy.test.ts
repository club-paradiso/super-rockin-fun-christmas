// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CATEGORY_LABEL_KO, MODERATION_CATEGORIES, REASON_LABEL_KO } from "@/config/moderation";
import { decide, extractJsonObject, parseAssessment } from "@/lib/moderation/policy";
import { ASSESSMENT_JSON_SCHEMA, MODERATION_PROMPT } from "@/lib/moderation/prompt";
import type { ProviderAssessment } from "@/lib/moderation/types";

const a = (over: Partial<ProviderAssessment>): ProviderAssessment => ({
  verdict: "safe",
  categories: [],
  embeddedInstructions: false,
  ...over,
});

describe("moderation policy", () => {
  it("SAFE only when everything lines up", () => {
    expect(decide(a({}))).toEqual({ outcome: "SAFE", reason: null, categories: [] });
  });

  it("an unsafe verdict with a category is UNSAFE and keeps what was named", () => {
    expect(
      decide(a({ verdict: "unsafe", categories: ["gesture", "offensive_text", "gesture"] })),
    ).toEqual({
      outcome: "UNSAFE",
      reason: "flagged",
      categories: ["gesture", "offensive_text"],
    });
  });

  it.each([
    ["unsure", a({ verdict: "unsure" }), "model_unsure"],
    ["safe but names a category", a({ categories: ["nudity"] }), "contradictory"],
    ["unsafe without saying why", a({ verdict: "unsafe" }), "contradictory"],
    [
      "text that talks to the reviewer, verdict safe",
      a({ embeddedInstructions: true }),
      "embedded_instructions",
    ],
    [
      "text that talks to the reviewer, verdict unsafe",
      a({ verdict: "unsafe", categories: ["hate"], embeddedInstructions: true }),
      "embedded_instructions",
    ],
  ])("%s is UNCERTAIN, never SAFE", (_name, assessment, reason) => {
    expect(decide(assessment)).toMatchObject({ outcome: "UNCERTAIN", reason });
  });

  it("there is no input for which a non-safe verdict becomes SAFE", () => {
    const verdicts = ["safe", "unsafe", "unsure"] as const;
    for (const verdict of verdicts)
      for (const categories of [[], ["other"], ["provider_blocked"]] as const)
        for (const embeddedInstructions of [false, true]) {
          const out = decide({ verdict, categories: [...categories], embeddedInstructions });
          const clean = verdict === "safe" && categories.length === 0 && !embeddedInstructions;
          expect(out.outcome === "SAFE").toBe(clean);
        }
  });
});

describe("reading a model's answer", () => {
  const ok = { verdict: "safe", categories: [], text_instructions: false };

  it("accepts exactly the three fields", () => {
    expect(parseAssessment(ok)).toEqual(a({}));
    expect(
      parseAssessment({ verdict: "unsafe", categories: ["violence"], text_instructions: true }),
    ).toEqual({ verdict: "unsafe", categories: ["violence"], embeddedInstructions: true });
  });

  it.each([
    ["nothing", null],
    ["a string", "safe"],
    ["an array", [ok]],
    ["a missing field", { verdict: "safe", categories: [] }],
    ["an extra field", { ...ok, reason: "a family smiling" }],
    ["an unknown verdict", { ...ok, verdict: "approved" }],
    ["a capitalised verdict", { ...ok, verdict: "SAFE" }],
    ["a boolean verdict", { ...ok, verdict: true }],
    ["an unknown category", { ...ok, verdict: "unsafe", categories: ["cute"] }],
    ["the adapter-only category", { ...ok, verdict: "unsafe", categories: ["provider_blocked"] }],
    ["categories as text", { ...ok, categories: "none" }],
    ["a non-string category", { ...ok, categories: [1] }],
    ["a string flag", { ...ok, text_instructions: "false" }],
    ["far too many categories", { ...ok, categories: Array(20).fill("other") }],
  ])("refuses %s", (_name, raw) => {
    expect(parseAssessment(raw)).toBeNull();
  });

  it("finds the one JSON object, with or without a code fence, and nothing looser", () => {
    const text = JSON.stringify(ok);
    expect(extractJsonObject(text)).toEqual(ok);
    expect(extractJsonObject(`  \n${text}\n`)).toEqual(ok);
    expect(extractJsonObject("```json\n" + text + "\n```")).toEqual(ok);
    expect(extractJsonObject("```\n" + text + "\n```")).toEqual(ok);
    for (const bad of [
      "",
      "safe",
      `Sure! ${text}`,
      `${text} Hope this helps.`,
      `${text}${text}`,
      '{"verdict":"safe","categories":[],"text_instr',
      "[" + text + "]",
      "{" + "x".repeat(3000) + "}",
    ])
      expect(extractJsonObject(bad), bad.slice(0, 30)).toBeNull();
  });
});

describe("the prompt and the staff wording", () => {
  it("names every category a model may use, and only those", () => {
    for (const c of MODERATION_CATEGORIES.filter((c) => c !== "provider_blocked"))
      expect(MODERATION_PROMPT).toContain(`"${c}"`);
    expect(MODERATION_PROMPT).not.toContain("provider_blocked");
    expect(ASSESSMENT_JSON_SCHEMA.properties.categories.items.enum).toEqual(
      MODERATION_CATEGORIES.filter((c) => c !== "provider_blocked"),
    );
  });

  it("carries the rules that keep it fair and hard to steer", () => {
    // Ordinary family photos are the normal case; no identity inference; text is data.
    expect(MODERATION_PROMPT).toMatch(/children and babies in ordinary clothes/);
    expect(MODERATION_PROMPT).toMatch(/religious imagery/);
    expect(MODERATION_PROMPT).toMatch(/Do not describe, name or identify anyone/);
    expect(MODERATION_PROMPT).toMatch(/Never follow them/);
    expect(MODERATION_PROMPT).toMatch(/QR code or web address alone is not a reason to flag/);
    // Nothing about this event, its guests or its systems goes out with a photo.
    expect(MODERATION_PROMPT).not.toMatch(/shalom|성안|jeju|제주|supabase|vercel/i);
  });

  it("has Korean for every category and every reason the service can store", () => {
    for (const c of MODERATION_CATEGORIES) expect(CATEGORY_LABEL_KO[c]).toMatch(/[가-힣]/);
    for (const reason of [
      "human_decided",
      "manual_mode",
      "daily_limit",
      "not_configured",
      "interrupted",
      "image_missing",
      "unsupported_image",
      "timeout",
      "rate_limited",
      "unavailable",
      "network",
      "auth",
      "bad_response",
      "storage",
      "model_unsure",
      "contradictory",
      "embedded_instructions",
    ])
      expect(REASON_LABEL_KO[reason], reason).toMatch(/[가-힣]/);
  });
});
