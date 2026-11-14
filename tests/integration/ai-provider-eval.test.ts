// @vitest-environment node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareModerationImage } from "@/lib/moderation/image";
import { decide } from "@/lib/moderation/policy";
import { createChatVisionProvider } from "@/lib/moderation/providers/chat-vision";
import { createGeminiProvider } from "@/lib/moderation/providers/gemini";
import { ProviderError, type ModerationProvider } from "@/lib/moderation/types";
import { parseServerConfig } from "@/lib/server/env";

/**
 * LIVE evaluation of the configured provider against a labelled set of pictures (D95). It makes
 * real requests, so it only runs when asked:
 *
 *   AI_EVAL_DIR=/path/to/set  AI_MODERATION_PROVIDER=… AI_MODERATION_API_KEY=… AI_MODERATION_MODEL=… \
 *     npx vitest run tests/integration/ai-provider-eval.test.ts
 *
 * The set is a folder with `manifest.json`:
 *   [{ "file": "family-01.jpg", "expect": "safe", "group": "family" },
 *    { "file": "gesture-03.jpg", "expect": "review", "group": "gesture" }, …]
 * "safe" = should be approved automatically; "review" = must NOT be (a person has to see it).
 *
 * Use only synthetic, staged or properly licensed pictures you are allowed to send to the
 * provider. NEVER guests' photos. docs/AI_MODERATION.md lists what the set should contain.
 *
 * It prints a confusion table and the measured latency. It fails on a single false approval of a
 * "review" picture: that is the error this system exists to prevent. False holds (a "safe"
 * picture left for a person) are reported, not failed: they cost a volunteer a tap.
 */
const DIR = process.env.AI_EVAL_DIR;

interface Item {
  file: string;
  expect: "safe" | "review";
  group?: string;
}

function providerFromEnv(): ModerationProvider {
  const { aiModeration, aiModerationProblem } = parseServerConfig({
    ...process.env,
    NODE_ENV: "test",
    KIOSK_AUTH_DISABLED: "1",
  });
  if (!aiModeration) throw new Error(aiModerationProblem ?? "AI_MODERATION_PROVIDER is not set");
  if (aiModeration.kind === "chat") return createChatVisionProvider(aiModeration);
  if (aiModeration.kind === "gemini") return createGeminiProvider(aiModeration);
  throw new Error("The mock provider has nothing to evaluate");
}

describe.skipIf(!DIR)("live provider evaluation", () => {
  it("never auto-approves a picture labelled for review", async () => {
    const provider = providerFromEnv();
    const items = JSON.parse(await readFile(path.join(DIR!, "manifest.json"), "utf8")) as Item[];
    const rows: Record<string, string | number>[] = [];
    const latencies: number[] = [];
    let falseApprovals = 0;
    let falseHolds = 0;
    for (const item of items) {
      const bytes = new Uint8Array(await readFile(path.join(DIR!, item.file)));
      const mime = item.file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      const image = await prepareModerationImage(bytes, mime);
      let outcome: string;
      let detail = "";
      const started = Date.now();
      if (!image) outcome = "UNSUPPORTED";
      else
        try {
          const decision = decide(
            await provider.analyze(
              image,
              AbortSignal.timeout(Number(process.env.AI_MODERATION_TIMEOUT_MS ?? 20_000)),
            ),
          );
          latencies.push(Date.now() - started);
          outcome = decision.outcome;
          detail = decision.categories.join(",") || (decision.reason ?? "");
        } catch (err) {
          outcome = "ERROR";
          detail = err instanceof ProviderError ? err.kind : String(err);
        }
      const approved = outcome === "SAFE";
      if (item.expect === "review" && approved) falseApprovals++;
      if (item.expect === "safe" && !approved) falseHolds++;
      rows.push({ file: item.file, group: item.group ?? "", expect: item.expect, outcome, detail });
      // Stay well inside a free tier's per-minute limit.
      await new Promise((r) => setTimeout(r, Number(process.env.AI_EVAL_PAUSE_MS ?? 2500)));
    }
    latencies.sort((a, b) => a - b);
    const pct = (p: number) =>
      latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
    console.table(rows);
    console.log(
      JSON.stringify({
        provider: provider.id,
        model: provider.model,
        pictures: items.length,
        expectedSafe: items.filter((i) => i.expect === "safe").length,
        expectedReview: items.filter((i) => i.expect === "review").length,
        falseApprovals,
        falseHolds,
        latencyMs: latencies.length
          ? { median: pct(0.5), p95: pct(0.95), n: latencies.length }
          : null,
      }),
    );
    expect(falseApprovals, "pictures labelled for review that were auto-approved").toBe(0);
  }, 3_600_000);
});
