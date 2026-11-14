import {
  ProviderError,
  type ModerationProvider,
  type ProviderAssessment,
  type ProviderErrorKind,
} from "../types";

export type MockBehaviour = "safe" | "unsafe" | "unsure" | "fail" | "slow";

/**
 * A provider that calls nobody. For tests, the E2E run and trying the staff screens on a laptop;
 * refused in a real deployment (lib/server/env.ts). `slow` never answers until aborted, which is
 * what a hung provider looks like.
 */
export function createMockProvider(
  behaviour: MockBehaviour | (() => ProviderAssessment | ProviderErrorKind) = "safe",
): ModerationProvider {
  return {
    id: "mock",
    model: "mock-1",
    async analyze(_image, signal) {
      const b = typeof behaviour === "function" ? behaviour() : behaviour;
      if (typeof b === "object") return b;
      switch (b) {
        case "safe":
          return { verdict: "safe", categories: [], embeddedInstructions: false };
        case "unsafe":
          return { verdict: "unsafe", categories: ["gesture"], embeddedInstructions: false };
        case "unsure":
          return { verdict: "unsure", categories: [], embeddedInstructions: false };
        case "slow":
          return new Promise<ProviderAssessment>((_, reject) => {
            const stop = () => reject(new ProviderError("timeout", "request timed out"));
            if (signal.aborted) stop();
            else signal.addEventListener("abort", stop, { once: true });
          });
        case "fail":
          throw new ProviderError("unavailable", "HTTP 503");
        default:
          throw new ProviderError(b, `mock ${b}`);
      }
    },
  };
}
