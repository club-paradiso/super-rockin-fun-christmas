import { extractJsonObject, parseAssessment } from "../policy";
import { MODERATION_PROMPT } from "../prompt";
import {
  ProviderError,
  type ModerationImage,
  type ModerationProvider,
  type ProviderAssessment,
} from "../types";
import { postJson, toBase64 } from "./http";

export interface ChatVisionOptions {
  /** Stored with each review, e.g. "cloudflare". */
  id: string;
  /** The API root that has `/chat/completions` under it. */
  baseUrl: URL;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

/**
 * A vision model behind an OpenAI-style `chat/completions` endpoint: the picture goes in as a
 * base64 data URL in the same request, never as a link (nothing of ours is fetchable from
 * outside). This one adapter serves every provider that speaks that format: Cloudflare Workers AI
 * (the primary, D95), and others such as Groq, by base URL and model name alone.
 *
 * The answer must be the one JSON object the prompt asks for. `response_format: json_object` is
 * requested because most such endpoints honour it, but nothing relies on it: the text is parsed
 * strictly either way, and anything else is `bad_response`.
 */
export function createChatVisionProvider(opts: ChatVisionOptions): ModerationProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.href.replace(/\/+$/, "")}/chat/completions`;
  return {
    id: opts.id,
    model: opts.model,
    async analyze(image: ModerationImage, signal: AbortSignal): Promise<ProviderAssessment> {
      const { json } = await postJson(
        url,
        { authorization: `Bearer ${opts.apiKey}` },
        {
          model: opts.model,
          temperature: 0,
          max_tokens: 200,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: MODERATION_PROMPT },
                {
                  type: "image_url",
                  image_url: { url: `data:${image.mime};base64,${toBase64(image.data)}` },
                },
              ],
            },
          ],
        },
        signal,
        fetchImpl,
      );
      const choice = (json as { choices?: unknown[] } | null)?.choices?.[0] as
        { finish_reason?: unknown; message?: { content?: unknown } } | undefined;
      if (!choice) throw new ProviderError("bad_response", "no choices");
      // The provider's own filter stopped the answer: it saw something. A person looks.
      if (choice.finish_reason === "content_filter")
        return { verdict: "unsafe", categories: ["provider_blocked"], embeddedInstructions: false };
      const content = choice.message?.content;
      const assessment =
        typeof content === "string" ? parseAssessment(extractJsonObject(content)) : null;
      if (!assessment) throw new ProviderError("bad_response", "answer did not match the schema");
      return assessment;
    },
  };
}
