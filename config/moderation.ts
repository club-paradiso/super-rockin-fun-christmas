/**
 * AI review knobs (D95). Change here, not inside the service or the adapters. Nothing in this file
 * is a secret: provider, key and model come from the environment (lib/server/env.ts).
 */
export const MODERATION_CONFIG = {
  /**
   * Provider requests per photo, ever (retries included). After this the photo simply waits for a
   * person. Small on purpose: a free tier is a budget, and a photo that fails three times is not
   * going to be read on the fourth.
   */
  maxAttempts: 3,
  /** How long one worker may hold a photo. A worker that dies gives it back after this. */
  leaseMs: 45_000,
  /** Wait before attempt 2, 3, … (a provider's own Retry-After, if longer, wins up to the cap). */
  retryBackoffMs: [5_000, 30_000],
  retryAfterCapMs: 5 * 60_000,
  /** Photos one sweep takes, and the pause between sweeps started by ordinary requests. */
  sweepBatch: 4,
  sweepEveryMs: 5_000,
  /**
   * The copies sent to the provider: long edge in pixels, JPEG quality. The stored photo is never
   * sent. Each shot of a frame is sent on its own (D97): a whole 1200×3600 strip scaled to 1024
   * leaves each shot about 300 px wide, and measured against a real provider that missed a raised
   * middle finger and stage blood in one shot of four, while the same shots alone were caught at
   * 448 px and at 640 px. `imageLongEdge` is for a frame with one photo, `shotLongEdge` for each
   * shot of a frame with several.
   */
  imageLongEdge: 1024,
  shotLongEdge: 640,
  imageQuality: 80,
  /** Refuse to decode anything larger than this many pixels (a decompression bomb). */
  maxInputPixels: 40_000_000,
  /**
   * The booth's "사진을 확인하고 있어요" line turns into the "조금 지연" line after this long, and
   * stops asking after `kioskStatusGiveUpMs`.
   */
  kioskStatusDelayedMs: 12_000,
  kioskStatusPollMs: 2_500,
  kioskStatusGiveUpMs: 90_000,
} as const;

/**
 * What the event does not put on a big screen in front of families. These codes are the whole
 * vocabulary between the provider adapters, the policy, the database and the staff screen: a
 * provider can only ever name one of these, never write free text about a guest.
 */
export const MODERATION_CATEGORIES = [
  "sexual",
  "nudity",
  "violence",
  "hate",
  "gesture",
  "offensive_text",
  "other",
  /** Set by an adapter when the provider itself refused to look at the picture. */
  "provider_blocked",
] as const;
export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

/** Staff-facing Korean, short. Shown as "AI가 본 것", never as a fact about the guest. */
export const CATEGORY_LABEL_KO: Record<ModerationCategory, string> = {
  sexual: "선정적인 장면",
  nudity: "노출",
  violence: "폭력·피",
  hate: "혐오·위협 표현이나 상징",
  gesture: "욕설 손동작",
  offensive_text: "욕설·비방 글자",
  other: "행사 화면에 맞지 않는 내용",
  provider_blocked: "AI 서비스가 확인을 거부함",
};

/** Why the AI did not give an answer, in staff Korean. Unknown codes fall back to a generic line. */
export const REASON_LABEL_KO: Record<string, string> = {
  human_decided: "스태프가 먼저 처리했어요",
  manual_mode: "수동 검수로 바뀌어 AI에 보내지 않았어요",
  daily_limit: "오늘 AI 사용 한도를 다 썼어요",
  not_configured: "AI 설정이 없어요",
  interrupted: "AI 확인이 중간에 끊겼어요",
  image_missing: "사진 파일을 읽지 못했어요",
  unsupported_image: "AI에 보낼 수 없는 사진이에요 (형식이나 틀을 알 수 없음)",
  timeout: "AI 응답이 너무 늦었어요",
  rate_limited: "AI 서비스 사용량 제한에 걸렸어요",
  unavailable: "AI 서비스가 응답하지 않았어요",
  network: "인터넷 연결 문제로 AI에 닿지 못했어요",
  auth: "AI 서비스 인증에 실패했어요 (키 확인 필요)",
  bad_response: "AI 응답을 읽을 수 없었어요",
  storage: "저장소 오류로 결과를 남기지 못했어요",
  model_unsure: "AI가 판단을 보류했어요",
  contradictory: "AI 응답이 앞뒤가 맞지 않았어요",
  embedded_instructions: "사진 속 글자가 AI에게 지시하는 내용이라 사람이 확인해야 해요",
};
