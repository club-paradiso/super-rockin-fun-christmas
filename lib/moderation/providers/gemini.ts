import { extractJsonObject, parseAssessment } from "../policy";
import { ASSESSMENT_JSON_SCHEMA, MODERATION_PROMPT } from "../prompt";
import {
  ProviderError,
  type ModerationImage,
  type ModerationProvider,
  type ProviderAssessment,
} from "../types";
import { postJson, toBase64 } from "./http";

export interface GeminiOptions {
  apiKey: string;
  model: string;
  baseUrl?: URL;
  fetchImpl?: typeof fetch;
}

/** Google refused the prompt or stopped the answer for a safety reason. */
const BLOCKED_FINISH = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "IMAGE_SAFETY",
  "BLOCKLIST",
  "SPII",
]);

/**
 * Google Gemini API, `models.generateContent` (the alternative provider, D95). The picture is
 * sent inline as base64, the answer is constrained to the assessment schema, and it is still
 * parsed strictly.
 *
 * PAID TIER ONLY. On Google's unpaid tier submitted content may be used to improve Google's
 * products and read by human reviewers, which rules it out for guests' photos; the server
 * configuration refuses this adapter unless the operator has confirmed the key's project is on
 * the paid tier (lib/server/env.ts). The adapter cannot check that itself.
 *
 * A prompt or answer Google blocks for safety is reported as `provider_blocked`: unsafe, for a
 * person to look at. It is never read as "nothing wrong".
 */
export function createGeminiProvider(opts: GeminiOptions): ModerationProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.baseUrl?.href ?? "https://generativelanguage.googleapis.com/v1beta").replace(
    /\/+$/,
    "",
  );
  const url = `${base}/models/${encodeURIComponent(opts.model)}:generateContent`;
  const blocked: ProviderAssessment = {
    verdict: "unsafe",
    categories: ["provider_blocked"],
    embeddedInstructions: false,
  };
  return {
    id: "gemini",
    model: opts.model,
    async analyze(image: ModerationImage, signal: AbortSignal): Promise<ProviderAssessment> {
      const { json } = await postJson(
        url,
        // In a header, not the query string: URLs end up in logs.
        { "x-goog-api-key": opts.apiKey },
        {
          contents: [
            {
              role: "user",
              parts: [
                { text: MODERATION_PROMPT },
                { inlineData: { mimeType: image.mime, data: toBase64(image.data) } },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 200,
            responseMimeType: "application/json",
            responseJsonSchema: ASSESSMENT_JSON_SCHEMA,
          },
        },
        signal,
        fetchImpl,
      );
      const body = json as {
        promptFeedback?: { blockReason?: unknown };
        candidates?: { finishReason?: unknown; content?: { parts?: { text?: unknown }[] } }[];
      } | null;
      if (body?.promptFeedback?.blockReason) return blocked;
      const candidate = body?.candidates?.[0];
      if (!candidate) throw new ProviderError("bad_response", "no candidates");
      if (typeof candidate.finishReason === "string" && BLOCKED_FINISH.has(candidate.finishReason))
        return blocked;
      const text = (candidate.content?.parts ?? [])
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .join("");
      const assessment = parseAssessment(extractJsonObject(text));
      if (!assessment) throw new ProviderError("bad_response", "answer did not match the schema");
      return assessment;
    },
  };
}
