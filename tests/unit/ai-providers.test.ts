// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createChatVisionProvider } from "@/lib/moderation/providers/chat-vision";
import { createGeminiProvider } from "@/lib/moderation/providers/gemini";
import { retryAfterMs } from "@/lib/moderation/providers/http";
import { createMockProvider } from "@/lib/moderation/providers/mock";
import { MODERATION_PROMPT } from "@/lib/moderation/prompt";
import type { ModerationImage, ModerationProvider } from "@/lib/moderation/types";

const IMAGE: ModerationImage = {
  data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 0xff, 0xd9]),
  mime: "image/jpeg",
  width: 4,
  height: 4,
};
const B64 = Buffer.from(IMAGE.data).toString("base64");
const KEY = "test-key-not-a-real-one";
const SAFE = { verdict: "safe", categories: [], text_instructions: false };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** A fetch that records what it was sent and answers with `respond`. */
function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init!,
      body: JSON.parse(String(init!.body)) as Record<string, unknown>,
    });
    return respond();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const chat = (fetchImpl: typeof fetch) =>
  createChatVisionProvider({
    id: "cloudflare",
    baseUrl: new URL("https://api.example.test/client/v4/accounts/abc/ai/v1/"),
    apiKey: KEY,
    model: "@cf/vendor/vision-model",
    fetchImpl,
  });
const gemini = (fetchImpl: typeof fetch) =>
  createGeminiProvider({ apiKey: KEY, model: "gemini-3.5-flash-lite", fetchImpl });

const chatAnswer = (content: unknown, finish = "stop") =>
  json({ choices: [{ finish_reason: finish, message: { role: "assistant", content } }] });
const geminiAnswer = (text: string, finishReason = "STOP") =>
  json({ candidates: [{ finishReason, content: { parts: [{ text }] } }] });

const signal = () => new AbortController().signal;

describe("chat-completions vision adapter (Cloudflare Workers AI and compatible)", () => {
  it("sends the prompt and the picture inline, the key in a header, and nothing else", async () => {
    const { impl, calls } = fakeFetch(() => chatAnswer(JSON.stringify(SAFE)));
    const result = await chat(impl).analyze(IMAGE, signal());
    expect(result).toEqual({ verdict: "safe", categories: [], embeddedInstructions: false });

    const [call] = calls;
    expect(call!.url).toBe(
      "https://api.example.test/client/v4/accounts/abc/ai/v1/chat/completions",
    );
    expect(call!.url).not.toContain(KEY);
    const headers = call!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call!.init.redirect).toBe("error");
    expect(call!.body).toEqual({
      model: "@cf/vendor/vision-model",
      temperature: 0,
      max_tokens: 200,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: MODERATION_PROMPT },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${B64}` } },
          ],
        },
      ],
    });
  });

  it("reads a fenced answer and an unsafe one", async () => {
    const unsafe = { verdict: "unsafe", categories: ["gesture"], text_instructions: false };
    const { impl } = fakeFetch(() => chatAnswer("```json\n" + JSON.stringify(unsafe) + "\n```"));
    expect(await chat(impl).analyze(IMAGE, signal())).toEqual({
      verdict: "unsafe",
      categories: ["gesture"],
      embeddedInstructions: false,
    });
  });

  it("a provider-side content filter is unsafe/provider_blocked, never safe", async () => {
    const { impl } = fakeFetch(() => chatAnswer(null, "content_filter"));
    expect(await chat(impl).analyze(IMAGE, signal())).toEqual({
      verdict: "unsafe",
      categories: ["provider_blocked"],
      embeddedInstructions: false,
    });
  });

  it.each([
    ["prose", "This photo looks fine to me!"],
    ["JSON with a story around it", `Here you go: ${JSON.stringify(SAFE)}`],
    ["truncated JSON", '{"verdict":"safe","categories":['],
    ["an extra field", JSON.stringify({ ...SAFE, note: "two adults" })],
    ["an empty answer", ""],
    ["a non-string answer", { verdict: "safe" }],
  ])("%s is bad_response", async (_name, content) => {
    const { impl } = fakeFetch(() => chatAnswer(content));
    await expect(chat(impl).analyze(IMAGE, signal())).rejects.toMatchObject({
      name: "ProviderError",
      kind: "bad_response",
    });
  });

  it("no choices at all is bad_response", async () => {
    const { impl } = fakeFetch(() => json({ choices: [] }));
    await expect(chat(impl).analyze(IMAGE, signal())).rejects.toMatchObject({
      kind: "bad_response",
    });
  });
});

describe("Gemini adapter", () => {
  it("sends the picture inline with the schema, the key in a header", async () => {
    const { impl, calls } = fakeFetch(() => geminiAnswer(JSON.stringify(SAFE)));
    expect(await gemini(impl).analyze(IMAGE, signal())).toEqual({
      verdict: "safe",
      categories: [],
      embeddedInstructions: false,
    });
    const [call] = calls;
    expect(call!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    );
    expect(call!.url).not.toContain(KEY);
    expect((call!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    const body = call!.body as {
      contents: { parts: Record<string, unknown>[] }[];
      generationConfig: Record<string, unknown>;
    };
    expect(body.contents[0]!.parts).toEqual([
      { text: MODERATION_PROMPT },
      { inlineData: { mimeType: "image/jpeg", data: B64 } },
    ]);
    expect(body.generationConfig).toMatchObject({
      temperature: 0,
      responseMimeType: "application/json",
    });
    expect(Object.keys(body).sort()).toEqual(["contents", "generationConfig"]);
  });

  it.each([
    ["a blocked prompt", json({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } })],
    ["a SAFETY finish", geminiAnswer("", "SAFETY")],
    ["an IMAGE_SAFETY finish", geminiAnswer("", "IMAGE_SAFETY")],
  ])("%s is unsafe/provider_blocked", async (_name, response) => {
    const { impl } = fakeFetch(() => response.clone());
    expect(await gemini(impl).analyze(IMAGE, signal())).toEqual({
      verdict: "unsafe",
      categories: ["provider_blocked"],
      embeddedInstructions: false,
    });
  });

  it.each([
    ["no candidates", json({})],
    ["an answer cut off at the token limit", geminiAnswer('{"verdict":"sa', "MAX_TOKENS")],
    ["prose", geminiAnswer("Looks good.")],
  ])("%s is bad_response", async (_name, response) => {
    const { impl } = fakeFetch(() => response.clone());
    await expect(gemini(impl).analyze(IMAGE, signal())).rejects.toMatchObject({
      kind: "bad_response",
    });
  });
});

describe.each([
  ["chat", chat],
  ["gemini", gemini],
] as [string, (f: typeof fetch) => ModerationProvider][])(
  "%s adapter: HTTP failures",
  (_name, make) => {
    it.each([
      [429, "rate_limited"],
      [408, "timeout"],
      [500, "unavailable"],
      [503, "unavailable"],
      [401, "auth"],
      [403, "auth"],
      [400, "bad_response"],
      [404, "bad_response"],
      [410, "bad_response"],
      [413, "bad_response"],
    ])("HTTP %i is %s", async (status, kind) => {
      const { impl } = fakeFetch(() =>
        json({ error: { message: `secret detail about ${KEY}` } }, status),
      );
      const err = await make(impl)
        .analyze(IMAGE, signal())
        .catch((e: Error) => e);
      expect(err).toMatchObject({ name: "ProviderError", kind });
      // The provider's own error text never travels with our error.
      expect((err as Error).message).toBe(`HTTP ${status}`);
    });

    it("passes on Retry-After from a 429", async () => {
      const { impl } = fakeFetch(() => json({}, 429, { "retry-after": "17" }));
      await expect(make(impl).analyze(IMAGE, signal())).rejects.toMatchObject({
        kind: "rate_limited",
        retryAfterMs: 17_000,
      });
    });

    it("a dropped connection is network; our own abort is timeout", async () => {
      const down = vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch;
      await expect(make(down).analyze(IMAGE, signal())).rejects.toMatchObject({ kind: "network" });

      const controller = new AbortController();
      const hung = vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ) as unknown as typeof fetch;
      const pending = make(hung).analyze(IMAGE, controller.signal);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ kind: "timeout" });
    });

    it("a 200 that is not JSON is bad_response", async () => {
      const { impl } = fakeFetch(() => new Response("<html>gateway</html>", { status: 200 }));
      await expect(make(impl).analyze(IMAGE, signal())).rejects.toMatchObject({
        kind: "bad_response",
      });
    });
  },
);

describe("Retry-After", () => {
  it("reads seconds and dates, and ignores nonsense", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs("0")).toBe(0);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs("soon")).toBeNull();
    const now = Date.parse("2026-12-01T00:00:00Z");
    expect(retryAfterMs("Tue, 01 Dec 2026 00:00:30 GMT", now)).toBe(30_000);
    expect(retryAfterMs("Tue, 01 Dec 2026 00:00:00 GMT", now + 5000)).toBe(0);
  });
});

describe("mock provider", () => {
  it("answers as told and hangs until aborted when slow", async () => {
    expect((await createMockProvider("safe").analyze(IMAGE, signal())).verdict).toBe("safe");
    expect((await createMockProvider("unsafe").analyze(IMAGE, signal())).verdict).toBe("unsafe");
    expect((await createMockProvider("unsure").analyze(IMAGE, signal())).verdict).toBe("unsure");
    await expect(createMockProvider("fail").analyze(IMAGE, signal())).rejects.toMatchObject({
      kind: "unavailable",
    });
    const c = new AbortController();
    const slow = createMockProvider("slow").analyze(IMAGE, c.signal);
    c.abort();
    await expect(slow).rejects.toMatchObject({ kind: "timeout" });
  });
});
