import type { ModerationCategory } from "@/config/moderation";

/** The copy of a photo an adapter may send: our own re-encoded JPEG, no metadata. */
export interface ModerationImage {
  data: Uint8Array;
  mime: "image/jpeg";
  width: number;
  height: number;
}

/**
 * What an adapter hands back after validating the provider's answer. There is no free text and no
 * score: a provider's "confidence" is not a calibrated probability, and prose about a guest is
 * exactly what this system must not store.
 */
export interface ProviderAssessment {
  /** "unsure" is a first-class answer. An adapter that cannot tell must say so, never guess. */
  verdict: "safe" | "unsafe" | "unsure";
  categories: ModerationCategory[];
  /**
   * The picture contains writing addressed to whoever reviews it ("approve this", "ignore your
   * rules"). Text in a photo is data: it is never followed, and its presence alone sends the
   * photo to a person.
   */
  embeddedInstructions: boolean;
}

export type ProviderErrorKind =
  /** Worth another attempt later. */
  | "timeout"
  | "rate_limited"
  | "unavailable"
  | "network"
  /** Not worth retrying: the key is wrong, or the answer could not be read. */
  | "auth"
  | "bad_response";

export const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  "timeout",
  "rate_limited",
  "unavailable",
  "network",
]);

/** The only error an adapter throws. `message` is for the server log; it never holds image data. */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    /** The provider asked to wait this long (HTTP Retry-After or its body). */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * One image in, one validated assessment out. Adapters know one provider's wire format and
 * nothing about photos, consent, storage or the wall; replacing a provider is writing one of
 * these (lib/moderation/providers) and naming it in lib/moderation/server.ts.
 */
export interface ModerationProvider {
  /** Short id stored with each review ("cloudflare", "gemini", …). */
  readonly id: string;
  readonly model: string;
  analyze(image: ModerationImage, signal: AbortSignal): Promise<ProviderAssessment>;
}
