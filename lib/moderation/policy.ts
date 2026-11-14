import { MODERATION_CATEGORIES, type ModerationCategory } from "@/config/moderation";
import type { ProviderAssessment } from "./types";

/**
 * The event's own safety policy (D95), in one place. A provider's general content policy is not
 * this policy: the prompt (prompt.ts) asks the provider about THESE categories, and this file
 * alone decides what an answer means.
 *
 *   SAFE       approve automatically (if every other server-side rule still allows it)
 *   UNSAFE     keep private, show staff first with what the AI named
 *   UNCERTAIN  keep private, a person decides
 *
 * The rule is asymmetric on purpose. SAFE needs everything to line up: verdict "safe", no category
 * named, no writing aimed at the reviewer. Anything missing, extra or contradictory is not SAFE.
 * A false "unsafe" costs a volunteer ten seconds; a false "safe" puts something on a 3-metre
 * screen in front of children.
 */
export type PolicyDecision =
  | { outcome: "SAFE"; reason: null; categories: [] }
  | { outcome: "UNSAFE"; reason: string; categories: ModerationCategory[] }
  | { outcome: "UNCERTAIN"; reason: string; categories: ModerationCategory[] };

const KNOWN = new Set<string>(MODERATION_CATEGORIES);

export function decide(a: ProviderAssessment): PolicyDecision {
  const categories = [...new Set(a.categories)].filter((c) => KNOWN.has(c));
  // Writing in the picture tried to talk to the reviewer. Whatever else the model said may have
  // been steered by it, so nothing it said is trusted, in either direction.
  if (a.embeddedInstructions)
    return { outcome: "UNCERTAIN", reason: "embedded_instructions", categories };
  if (a.verdict === "unsafe") {
    return categories.length
      ? { outcome: "UNSAFE", reason: "flagged", categories }
      : // "Unsafe" without saying why is not something staff can act on as a flag.
        { outcome: "UNCERTAIN", reason: "contradictory", categories };
  }
  if (a.verdict === "safe") {
    return categories.length
      ? { outcome: "UNCERTAIN", reason: "contradictory", categories }
      : { outcome: "SAFE", reason: null, categories: [] };
  }
  return { outcome: "UNCERTAIN", reason: "model_unsure", categories };
}

/**
 * Strict reader for a model's JSON answer, shared by the chat-style adapters. Exactly the three
 * known fields with exactly the known values; anything else is null and the adapter reports
 * `bad_response`. Never "close enough": a truncated or chatty answer is not an answer.
 */
export function parseAssessment(raw: unknown): ProviderAssessment | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "categories,text_instructions,verdict") return null;
  if (o.verdict !== "safe" && o.verdict !== "unsafe" && o.verdict !== "unsure") return null;
  if (typeof o.text_instructions !== "boolean") return null;
  if (!Array.isArray(o.categories) || o.categories.length > MODERATION_CATEGORIES.length)
    return null;
  const categories: ModerationCategory[] = [];
  for (const c of o.categories) {
    // An adapter-only code is not something a model may claim.
    if (typeof c !== "string" || !KNOWN.has(c) || c === "provider_blocked") return null;
    categories.push(c as ModerationCategory);
  }
  return { verdict: o.verdict, categories, embeddedInstructions: o.text_instructions };
}

/**
 * The one JSON object in a model's text answer, or null. Accepts a bare object or one inside a
 * single ```json fence (models add it even when told not to); refuses anything with other prose
 * around it, more than one object, or invalid JSON.
 */
export function extractJsonObject(text: string): unknown | null {
  let t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fenced) t = fenced[1]!.trim();
  if (!t.startsWith("{") || !t.endsWith("}") || t.length > 2_000) return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return null;
  }
}
