"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrandLockup } from "@/components/brand";
import { StampTicket } from "@/components/studio/stamp-ticket";
import { cleanOrdinal } from "@/lib/studio/day";
import {
  DEFAULT_CARD_ID,
  FRAME_CARDS,
  cleanOptions,
  defaultOptions,
  getCard,
  usesHandwriting,
  type FrameCard,
  type FrameCardId,
  type FrameOptions,
  type OptionValue,
} from "@/config/frames/v2";
import { pickHandFont } from "@/config/hand-fonts";
import { KIOSK_CONFIG } from "@/config/kiosk";
import { MOBILE_FRAMES, MOBILE_UPLOAD_CONFIG } from "@/config/mobile";
import { canvasToBlob, createDomCanvas } from "@/lib/canvas";
import { loadFrameAssets } from "@/lib/compositor/assets";
import { composeFrame, formatDateLabel, formatStampLabel } from "@/lib/compositor/compose";
import { loadFrameFonts } from "@/lib/compositor/fonts";
import { loadSamplePhotos, useServerClock } from "@/components/kiosk/frame-preview";
import type { ComposeImage } from "@/lib/compositor/types";
import { KIOSK_COPY } from "@/lib/kiosk/copy";
import {
  decodePhotoFile,
  drawPhoto,
  limitPicked,
  settleSelection,
  toggleOrdered,
  type DecodeFailure,
} from "@/lib/mobile/prepare";

/**
 * The phone page goes in the booth's order (D103): choose a frame, choose exactly as many photos
 * as it holds in the order they go in, then answer the media-wall question with two equal answers.
 * Either way the guest can save the finished picture; only a "yes" sends it anywhere.
 *
 * The frames are the booth's own: the eight cards of 「틀 선택 v2」 and their options (colour,
 * logo, tone), each combination its own frame id, exactly as on the booth. The frames the booth
 * dropped on 2026-11-22 are never offered here.
 */
type Phase =
  | { name: "frame" }
  | { name: "photos" }
  | { name: "preparing" }
  | { name: "consent" }
  | { name: "uploading"; progress: number; attempt: number }
  /** ordinal: "오늘 N번째 기록" as the server counted it; null when unknown. */
  | { name: "done"; ordinal: number | null }
  /** The guest said no to the wall: the picture stays on the phone, nothing was sent. */
  | { name: "kept" }
  | { name: "error"; reason: string; message: string; retry: boolean }
  | { name: "expired" };

/** Network trouble is retried by itself this many times, with growing waits, before asking. */
const AUTO_RETRIES = [1_000, 3_000, 7_000];

/** The booth's own words for the same steps (lib/kiosk/copy.ts, the user's wording, D76). */
const BOOTH = KIOSK_COPY.ko;

const ERRORS: Record<string, { message: string; retry: boolean }> = {
  heic: {
    message:
      "이 사진 형식(HEIC)은 이 브라우저에서 열 수 없어요. 사진을 스크린샷으로 찍거나, 카메라 설정에서 ‘호환성 우선’으로 찍은 사진을 골라 주세요.",
    retry: false,
  },
  unreadable: {
    message: "이 파일은 사진으로 열 수 없어요. 다른 사진을 골라 주세요.",
    retry: false,
  },
  too_small: { message: "사진이 너무 작아요. 더 큰 사진을 골라 주세요.", retry: false },
  consent: { message: "미디어월 질문에 다시 답해 주세요.", retry: false },
  paused: {
    message: "지금은 미디어월 게시 신청을 잠시 멈췄어요. 완성된 사진은 아래에서 저장할 수 있어요.",
    retry: false,
  },
  closed: { message: "이 QR로 보낸 사진은 이미 처리됐어요.", retry: false },
  too_large: { message: "사진이 너무 커요. 다른 사진을 골라 주세요.", retry: false },
  frame: { message: "사진을 틀에 담지 못했어요. 사진을 다시 골라 주세요.", retry: false },
  network: {
    message: "인터넷 연결이 불안정해요. 연결을 확인한 뒤 다시 보내기를 눌러 주세요.",
    retry: true,
  },
  server: { message: "잠시 문제가 생겼어요. 조금 뒤 다시 보내기를 눌러 주세요.", retry: true },
};

const fail = (reason: keyof typeof ERRORS): Phase => ({
  name: "error",
  reason,
  ...ERRORS[reason]!,
});

type SendOutcome = "ok" | "expired" | keyof typeof ERRORS;

/** One POST with upload progress (fetch cannot report it). Resolves to an outcome, never throws. */
function send(
  token: string,
  blob: Blob,
  /** The booth frame the photos are in (D93). */
  frameId: string,
  /** The consent text on screen included the public-wall line (D86). */
  publicWall: boolean,
  onProgress: (fraction: number) => void,
  /** Hears "오늘 N번째 기록" from a successful answer (optional; never affects the outcome). */
  onOrdinal: (ordinal: number | null) => void = () => {},
): Promise<SendOutcome> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/mobile/upload");
    xhr.setRequestHeader("content-type", "image/jpeg");
    xhr.setRequestHeader("x-upload-token", token);
    xhr.setRequestHeader("x-wall-consent", "yes");
    xhr.setRequestHeader("x-frame-id", frameId);
    if (publicWall) xhr.setRequestHeader("x-wall-scope", "public");
    xhr.timeout = 60_000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      const code = (() => {
        try {
          return (JSON.parse(xhr.responseText) as { error?: string }).error ?? "";
        } catch {
          return "";
        }
      })();
      if (xhr.status === 200 || xhr.status === 201) {
        try {
          onOrdinal(
            cleanOrdinal((JSON.parse(xhr.responseText) as { dayOrdinal?: unknown }).dayOrdinal),
          );
        } catch {
          onOrdinal(null);
        }
        resolve("ok");
      } else if (xhr.status === 410) resolve("expired");
      else if (xhr.status === 409) resolve(code === "paused" ? "paused" : "closed");
      else if (xhr.status === 413) resolve("too_large");
      else if (xhr.status === 400 && code === "too_small") resolve("too_small");
      else if (xhr.status === 400 && code === "consent required") resolve("consent");
      else if (xhr.status === 400 && code === "frame") resolve("frame");
      else if (xhr.status === 400 || xhr.status === 415) resolve("unreadable");
      else resolve("server");
    };
    xhr.onerror = () => resolve("network");
    xhr.ontimeout = () => resolve("network");
    xhr.send(blob);
  });
}

export function MobileUpload({
  token,
  publicWall,
  expiresAt,
  alreadySent,
  serverNow,
}: {
  token: string;
  /** The server's time when the page was made: the date stamp is the server's day, never the phone's. */
  serverNow?: string;
  /** Staff have the public wall on: say so in the consent text and send that scope. */
  publicWall: boolean;
  expiresAt: string;
  alreadySent: boolean;
}) {
  const [phase, setPhase] = useState<Phase>(
    alreadySent ? { name: "done", ordinal: null } : { name: "frame" },
  );
  // The booth preselects the same card (필름 3컷) with its default options.
  const [cardId, setCardId] = useState<FrameCardId>(DEFAULT_CARD_ID);
  const [options, setOptions] = useState<FrameOptions>(() =>
    defaultOptions(getCard(DEFAULT_CARD_ID)),
  );
  // The handwriting font is drawn once per guest, as on the booth (config/hand-fonts.ts).
  const [handFont] = useState(() => pickHandFont(null, Math.random()).id);
  const clock = useServerClock(serverNow);
  // Every photo the guest has picked so far, already shrunk (MOBILE_UPLOAD_CONFIG.sourceLongEdge),
  // and which of them go into the frame, in order (indices into `pool`).
  const [pool, setPool] = useState<ComposeImage[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [dropped, setDropped] = useState(0);
  const [assets, setAssets] = useState<Map<string, ComposeImage> | null>(null);
  // The booth's own sample photos (public/frames/v2/samples) for the frame picker.
  const [samples, setSamples] = useState<ComposeImage[] | null>(null);
  // The encoded picture, with the frame and photo list it was made from: composing is async, so
  // the guest's current choice can be ahead of it for a moment.
  const [preview, setPreview] = useState<{
    url: string;
    blob: Blob;
    frameId: string;
    photos: ComposeImage[];
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sending = useRef(false);

  const card = getCard(cardId);
  const frame = card.frame(cleanOptions(card, options));
  const required = frame.slots.length;
  const chosen = useMemo(() => selected.map((i) => pool[i]!), [selected, pool]);

  // The QR stops working after its time; say so instead of failing on submit. A guest who kept
  // the picture for themselves needs no QR any more and keeps their screen.
  useEffect(() => {
    if (phase.name === "done" || phase.name === "kept") return;
    const ms = new Date(expiresAt).getTime() - Date.now();
    const timer = setTimeout(() => setPhase({ name: "expired" }), Math.max(0, ms));
    return () => clearTimeout(timer);
  }, [expiresAt, phase.name]);

  // Release the preview's object URL whenever it is replaced, and on leaving.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  // The frames draw the brand font and their own pictures: load both before composing (D93),
  // as the booth does. A font or picture that fails to load never blocks the guest.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      loadFrameFonts(MOBILE_FRAMES),
      loadFrameAssets(MOBILE_FRAMES),
      loadSamplePhotos(),
    ]).then(([, loaded, photos]) => {
      if (cancelled) return;
      setSamples(photos);
      setAssets(loaded.assets);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Free the shrunk photos' pixels when the page goes away.
  const poolRef = useRef<ComposeImage[]>([]);
  useEffect(() => {
    poolRef.current = pool;
  }, [pool]);
  useEffect(() => () => release(poolRef.current), []);

  // The day on the frame is the server's (Asia/Seoul), as on the booth.
  const [labels] = useState(() => {
    const now = clock.now();
    return { dateLabel: formatDateLabel(now), stampLabel: formatStampLabel(now) };
  });
  const context = useMemo(
    () => (assets ? { ...labels, handFont, assets } : null),
    [assets, labels, handFont],
  );

  // The frame picker shows the booth's sample photos until the guest has their own, then their
  // own, repeated to fill frames that hold more than they picked.
  const thumbSource = useMemo(() => {
    if (!samples) return null;
    if (pool.length === 0) return samples;
    return [0, 1, 2, 3].map((i) => pool[i % pool.length]!);
  }, [samples, pool]);
  const fill = (f: { slots: readonly unknown[] }, photos: readonly ComposeImage[]) =>
    f.slots.map((_, i) => photos[i % photos.length]!);

  const onFrameScreen = phase.name === "frame";
  const thumbs = useMemo(() => {
    const out: Record<string, string> = {};
    if (!context || !thumbSource || !onFrameScreen) return out;
    for (const c of FRAME_CARDS) {
      const f = c.frame(defaultOptions(c));
      const canvas = composeFrame(f, fill(f, thumbSource), {
        createCanvas: createDomCanvas,
        context,
        scale: KIOSK_CONFIG.thumbScale / 2,
      }) as HTMLCanvasElement;
      out[c.id] = canvas.toDataURL("image/jpeg", 0.8);
      canvas.width = canvas.height = 0;
    }
    return out;
  }, [context, thumbSource, onFrameScreen]);

  // The chosen frame, larger, above the tiles.
  const framePreview = useMemo(() => {
    if (!context || !thumbSource || !onFrameScreen) return null;
    const canvas = composeFrame(frame, fill(frame, thumbSource), {
      createCanvas: createDomCanvas,
      context,
      scale: 0.5,
    }) as HTMLCanvasElement;
    const url = canvas.toDataURL("image/jpeg", 0.85);
    canvas.width = canvas.height = 0;
    return url;
  }, [context, thumbSource, frame, onFrameScreen]);

  // The JPEG that will be saved or sent: the chosen photos in the chosen frame at the booth's
  // saved size. Preview = result.
  const composing = phase.name === "consent" || phase.name === "uploading";
  useEffect(() => {
    if (!context || !composing || chosen.length !== required) return;
    if (preview && preview.frameId === frame.id && preview.photos === chosen) return;
    let cancelled = false;
    (async () => {
      try {
        const canvas = composeFrame(frame, chosen, {
          createCanvas: createDomCanvas,
          context: { ...context, handFont: usesHandwriting(frame) ? handFont : undefined },
          scale: KIOSK_CONFIG.outputScale,
        }) as HTMLCanvasElement;
        const blob = await canvasToBlob(
          canvas,
          "image/jpeg",
          MOBILE_UPLOAD_CONFIG.clientJpegQuality,
        );
        canvas.width = canvas.height = 0; // let the browser drop the pixels now
        if (cancelled) return;
        setPreview({ url: URL.createObjectURL(blob), blob, frameId: frame.id, photos: chosen });
      } catch {
        if (!cancelled) setPhase(fail("unreadable"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [context, composing, chosen, required, frame, handFont, preview]);

  // Only a picture made from what is on screen now may be saved or sent: never an older frame's
  // picture under the new frame's id (the server would refuse it), never an older choice.
  const current =
    preview && preview.frameId === frame.id && preview.photos === chosen ? preview : null;

  const pick = async (list: FileList | null) => {
    const files = list ? [...list] : [];
    if (files.length === 0) return;
    const room = MOBILE_UPLOAD_CONFIG.maxPhotos - poolRef.current.length;
    const { kept, dropped: left } = limitPicked(files, room);
    setPhase({ name: "preparing" });
    const shrunk: ComposeImage[] = [];
    try {
      // One at a time, each shrunk and its full-size bitmap freed before the next is opened.
      for (const file of kept) {
        const decoded = await decodePhotoFile(file);
        try {
          const canvas = drawPhoto(
            decoded,
            0,
            null,
            MOBILE_UPLOAD_CONFIG.sourceLongEdge,
            createDomCanvas,
          ) as HTMLCanvasElement;
          shrunk.push({ source: canvas, width: canvas.width, height: canvas.height });
        } finally {
          if ("close" in decoded.source) (decoded.source as ImageBitmap).close();
        }
      }
    } catch (failure) {
      release(shrunk);
      setPhase(fail((failure as DecodeFailure) === "heic" ? "heic" : "unreadable"));
      return;
    }
    const next = [...poolRef.current, ...shrunk];
    poolRef.current = next;
    setDropped(left);
    setPool(next);
    setSelected((s) => settleSelection(s, next.length, required));
    setPhase({ name: "photos" });
  };

  const choose = () => inputRef.current?.click();

  const clearPool = () => {
    release(poolRef.current);
    poolRef.current = [];
    setPool([]);
    setSelected([]);
    setDropped(0);
  };

  const confirmFrame = () => {
    setSelected((s) => settleSelection(s, pool.length, required));
    setPhase({ name: "photos" });
  };

  const answerYes = useCallback(async () => {
    if (!current || sending.current) return;
    sending.current = true;
    try {
      for (let attempt = 0; ; attempt++) {
        setPhase({ name: "uploading", progress: 0, attempt });
        let ordinal: number | null = null;
        const outcome = await send(
          token,
          current.blob,
          current.frameId,
          publicWall,
          (progress) => setPhase({ name: "uploading", progress, attempt }),
          (n) => {
            ordinal = n;
          },
        );
        if (outcome === "ok") return setPhase({ name: "done", ordinal });
        if (outcome === "expired") return setPhase({ name: "expired" });
        if (ERRORS[outcome]!.retry && attempt < AUTO_RETRIES.length) {
          await new Promise((r) => setTimeout(r, AUTO_RETRIES[attempt]));
          continue;
        }
        return setPhase(fail(outcome));
      }
    } finally {
      sending.current = false;
    }
  }, [current, token, publicWall]);

  return (
    // Korean never breaks inside a word on a narrow phone (it read "선택했/어요").
    <main className="min-h-dvh break-keep px-5 pb-12 pt-8" data-testid="mobile-upload">
      <div className="mx-auto flex max-w-md flex-col gap-6">
        <header className="text-center">
          <BrandLockup className="text-[52px]" />
          <h1 className="mt-5 text-2xl font-bold text-ink">내 사진으로 참여하기</h1>
          <Steps phase={phase.name} />
        </header>

        <input
          ref={inputRef}
          type="file"
          // image/* lets iPhone hand over a JPEG where it can; HEIC is handled below if not.
          accept="image/*"
          multiple
          className="sr-only"
          data-testid="mobile-file"
          aria-label="사진 고르기"
          onChange={(e) => {
            void pick(e.target.files);
            e.target.value = "";
          }}
        />

        {phase.name === "frame" && (
          <section className="flex flex-col gap-5" data-testid="mobile-step-frame">
            <h2 className="text-center text-xl font-bold text-ink">{BOOTH.phoneFrame.pickTitle}</h2>
            <figure className="flex flex-col items-center gap-2 rounded-3xl bg-paper p-3">
              {framePreview ? (
                // eslint-disable-next-line @next/next/no-img-element -- local data URL
                <img
                  src={framePreview}
                  alt={`${frame.label} 틀 미리보기`}
                  data-testid="mobile-frame-preview"
                  data-frame={frame.id}
                  className="max-h-[38dvh] w-auto rounded-lg"
                />
              ) : (
                <span className="h-[38dvh]" aria-hidden />
              )}
              <figcaption className="text-lg font-bold text-ink">
                {BOOTH.name[card.id]}{" "}
                <span className="text-base font-normal text-ink/75">
                  {BOOTH.frame.slots(required)}
                </span>
              </figcaption>
            </figure>
            <CardOptions
              card={card}
              options={cleanOptions(card, options)}
              onChange={(key, value) => setOptions((o) => ({ ...o, [key]: value }))}
            />
            <FramePicker
              frames={FRAME_CARDS.map((c) => ({
                id: c.id,
                label: BOOTH.name[c.id],
                thumb: thumbs[c.id],
              }))}
              selected={card.id}
              onSelect={(id) => {
                const next = getCard(id);
                setCardId(next.id);
                setOptions(defaultOptions(next));
              }}
            />
            <button
              type="button"
              className="btn-primary w-full"
              data-testid="mobile-frame-confirm"
              onClick={confirmFrame}
            >
              {BOOTH.phoneFrame.confirm}
            </button>
          </section>
        )}

        {phase.name === "photos" && (
          <section className="flex flex-col gap-4 text-center" data-testid="mobile-step-photos">
            <h2 className="text-xl font-bold text-ink">
              {pool.length > required
                ? BOOTH.select.title(required, pool.length)
                : `사진을 ${required}장 골라주세요`}
            </h2>
            <p className="text-base leading-relaxed text-ink/75" data-testid="mobile-select-lead">
              {pool.length === 0
                ? `휴대폰에 있는 사진을 골라 주세요. ${BOOTH.name[card.id]} 틀에 ${required}장이 들어가요.`
                : BOOTH.select.lead(selected.length, required)}
            </p>
            {pool.length > 0 && (
              <PhotoGrid
                photos={pool}
                selected={selected}
                onToggle={(i) => setSelected((s) => toggleOrdered(s, i, required))}
              />
            )}
            {dropped > 0 && (
              <p className="text-base text-ink/75" data-testid="mobile-dropped">
                사진은 {MOBILE_UPLOAD_CONFIG.maxPhotos}장까지 담아 둘 수 있어요. {dropped}장은 담지
                않았어요.
              </p>
            )}
            {pool.length < required ? (
              <>
                {pool.length > 0 && (
                  <p className="text-base font-semibold text-ink" data-testid="mobile-need-more">
                    사진이 {required - pool.length}장 더 필요해요.
                  </p>
                )}
                <button
                  type="button"
                  className="btn-primary w-full"
                  data-testid="mobile-choose"
                  onClick={choose}
                >
                  {pool.length === 0 ? "사진 고르기" : "사진 더 고르기"}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn-primary w-full"
                  data-testid="mobile-select-confirm"
                  disabled={selected.length !== required}
                  onClick={() => setPhase({ name: "consent" })}
                >
                  {BOOTH.select.confirm}
                </button>
                {pool.length < MOBILE_UPLOAD_CONFIG.maxPhotos && (
                  <button type="button" className="btn-quiet self-center" onClick={choose}>
                    사진 더 고르기
                  </button>
                )}
              </>
            )}
            <div className="flex flex-wrap justify-center gap-2">
              <button
                type="button"
                className="btn-quiet"
                data-testid="mobile-change-frame"
                onClick={() => setPhase({ name: "frame" })}
              >
                {BOOTH.phoneFrame.changeFrame}
              </button>
              {pool.length > 0 && (
                <button type="button" className="btn-quiet" onClick={clearPool}>
                  고른 사진 비우기
                </button>
              )}
            </div>
          </section>
        )}

        {phase.name === "preparing" && (
          <p className="text-center text-lg text-ink/75" role="status">
            사진을 준비하고 있어요…
          </p>
        )}

        {(phase.name === "consent" || phase.name === "uploading") && (
          <section className="flex flex-col gap-5" data-testid="mobile-step-consent">
            <figure className="flex justify-center rounded-3xl bg-paper p-3">
              {current ? (
                // eslint-disable-next-line @next/next/no-img-element -- local object URL
                <img
                  src={current.url}
                  alt="완성된 사진"
                  data-testid="mobile-preview"
                  className="max-h-[46dvh] w-auto rounded-lg"
                />
              ) : (
                <p className="py-16 text-lg text-ink/75" role="status">
                  {BOOTH.consent.making}
                </p>
              )}
            </figure>
            {phase.name === "consent" && (
              <>
                <div className="text-center">
                  <h2 className="whitespace-pre-line text-2xl font-bold text-ink">
                    {BOOTH.consent.title}
                  </h2>
                  <p className="mt-2 whitespace-pre-line text-lg leading-relaxed text-ink/75">
                    {BOOTH.consent.lead}
                  </p>
                  {/* D86: said before the answer, at the lead's size, never in the small print. */}
                  {publicWall && (
                    <p
                      className="mt-2 text-lg leading-relaxed text-ink/75"
                      data-testid="mobile-public-note"
                    >
                      {BOOTH.consent.publicNote}
                    </p>
                  )}
                </div>
                <Notes />
                {/* Equal size and weight on purpose, as on the booth: neither answer is the
                    "right" one, and "no" still gives the guest their picture. */}
                <div className="flex flex-col gap-3">
                  <button
                    type="button"
                    className="btn-secondary w-full"
                    data-testid="mobile-yes"
                    disabled={!current}
                    onClick={() => void answerYes()}
                  >
                    {BOOTH.consent.yes}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary w-full"
                    data-testid="mobile-no"
                    disabled={!current}
                    onClick={() => setPhase({ name: "kept" })}
                  >
                    {BOOTH.consent.no}
                  </button>
                </div>
                <button
                  type="button"
                  className="btn-quiet self-center"
                  onClick={() => setPhase({ name: "photos" })}
                >
                  사진 다시 고르기
                </button>
              </>
            )}
            {phase.name === "uploading" && (
              <div role="status" className="flex flex-col gap-3 text-center">
                <p className="text-lg text-ink" data-testid="mobile-uploading">
                  {phase.attempt > 0 ? "다시 보내고 있어요…" : "보내고 있어요…"}
                </p>
                <div
                  className="h-3 overflow-hidden rounded-full bg-ink/20"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(phase.progress * 100)}
                  aria-label="보내는 중"
                >
                  <div
                    className="h-full bg-button transition-[width]"
                    style={{ width: `${Math.round(phase.progress * 100)}%` }}
                  />
                </div>
              </div>
            )}
          </section>
        )}

        {phase.name === "done" && (
          <section className="flex flex-col gap-4 text-center" data-testid="mobile-done">
            <p className="text-5xl" aria-hidden>
              ✓
            </p>
            <h2 className="text-2xl font-bold text-ink">사진을 받았어요</h2>
            <p className="text-lg leading-relaxed text-ink/75">
              운영팀이 확인하고 있어요. 확인이 끝나면 미디어월에 걸려요.
              <br />
              <strong className="text-ink">아직 미디어월에 나온 것은 아니에요.</strong>
            </p>
            <p className="text-base text-ink/75">
              내리고 싶으면 현장 안내 봉사자에게 말씀해 주세요.
            </p>
            {preview && <SavePicture url={preview.url} />}
            <StampTicket info={{ ordinal: phase.ordinal, createdAt: new Date() }} />
          </section>
        )}

        {phase.name === "kept" && current && (
          <section className="flex flex-col gap-4 text-center" data-testid="mobile-kept">
            <h2 className="text-2xl font-bold text-ink">사진이 완성됐어요</h2>
            <p className="text-lg leading-relaxed text-ink/75">
              미디어월에는 보내지 않았어요.
              <br />이 창을 닫으면 사진이 사라지니 먼저 저장해 주세요.
            </p>
            <figure className="flex justify-center rounded-3xl bg-paper p-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- local object URL */}
              <img
                src={current.url}
                alt="완성된 사진"
                className="max-h-[46dvh] w-auto rounded-lg"
              />
            </figure>
            <SavePicture url={current.url} />
          </section>
        )}

        {phase.name === "error" && (
          <section
            className="flex flex-col gap-4 text-center"
            role="alert"
            data-testid="mobile-error"
          >
            <h2 className="text-xl font-bold text-ink">보내지 못했어요</h2>
            <p className="text-lg leading-relaxed text-ink/75">{phase.message}</p>
            {phase.retry && current ? (
              <button type="button" className="btn-primary w-full" onClick={() => void answerYes()}>
                다시 보내기
              </button>
            ) : phase.reason === "paused" && current ? (
              <SavePicture url={current.url} />
            ) : (
              <button
                type="button"
                className="btn-primary w-full"
                onClick={() => setPhase({ name: "photos" })}
              >
                사진 다시 고르기
              </button>
            )}
          </section>
        )}

        {phase.name === "expired" && (
          <section className="flex flex-col gap-4 text-center" data-testid="mobile-expired">
            <h2 className="text-xl font-bold text-ink">이 QR은 시간이 지났어요</h2>
            <p className="text-lg leading-relaxed text-ink/75">
              포토부스에서 &lsquo;내 사진으로 참여하기&rsquo;를 다시 눌러 새 QR을 받아 주세요.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}

/** Let the browser drop the pixels of shrunk photos (canvases) now. */
function release(photos: readonly ComposeImage[]) {
  for (const p of photos) {
    const canvas = p.source as HTMLCanvasElement;
    if ("width" in canvas) canvas.width = canvas.height = 0;
  }
}

/**
 * Saves the finished picture on the phone. It never leaves the phone this way: the link is the
 * picture's own local address. Long-press is the fallback where a browser ignores `download`.
 */
function SavePicture({ url }: { url: string }) {
  return (
    <div className="flex flex-col gap-2">
      <a
        href={url}
        download="studio-shalom.jpg"
        className="btn-primary w-full"
        data-testid="mobile-save"
      >
        사진 저장하기
      </a>
      <p className="text-base text-ink/75">저장되지 않으면 사진을 길게 눌러 저장해 주세요.</p>
    </div>
  );
}

/**
 * A card's options (colour, logo, tone) as the booth's options screen has them: one row per
 * option, every answer a button of the same size, the chosen one filled. Nothing for a card
 * without options.
 */
function CardOptions({
  card,
  options,
  onChange,
}: {
  card: FrameCard;
  options: FrameOptions;
  onChange: (key: FrameCard["options"][number]["key"], value: OptionValue) => void;
}) {
  if (card.options.length === 0) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="mobile-frame-options">
      {card.options.map((o) => (
        <div
          key={o.key}
          role="radiogroup"
          aria-label={BOOTH.label[o.key]}
          className="flex flex-col gap-1.5"
        >
          <span className="text-center text-base font-semibold text-ink">{BOOTH.label[o.key]}</span>
          <div className="flex justify-center gap-2">
            {o.values.map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={options[o.key] === v}
                data-testid={`mobile-option-${o.key}-${v}`}
                onClick={() => onChange(o.key, v)}
                className={`min-h-12 min-w-20 rounded-full px-4 text-base font-semibold ${
                  options[o.key] === v
                    ? "bg-button text-button-text"
                    : "border border-ink/40 text-ink"
                }`}
              >
                {BOOTH.value[v]}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The booth's eight cards, each with sample photos (or the guest's own) in it, in picker order. */
function FramePicker({
  frames,
  selected,
  onSelect,
}: {
  frames: { id: FrameCardId; label: string; thumb: string | undefined }[];
  selected: string;
  onSelect: (id: FrameCardId) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="틀 고르기"
      // Two across keeps the longest name ("35mm 필름 4컷") whole at 360 px.
      className="grid grid-cols-2 gap-2"
      data-testid="mobile-frames"
    >
      {frames.map((f) => (
        <button
          key={f.id}
          type="button"
          role="radio"
          aria-checked={selected === f.id}
          data-frame-id={f.id}
          onClick={() => onSelect(f.id)}
          className={`flex min-h-12 min-w-0 flex-col items-center gap-1 rounded-2xl p-1.5 text-sm font-semibold text-ink ${
            selected === f.id ? "bg-paper ring-2 ring-ink" : "border border-ink/30"
          }`}
        >
          {f.thumb ? (
            // eslint-disable-next-line @next/next/no-img-element -- local data URL
            <img src={f.thumb} alt="" className="h-20 w-auto object-contain" />
          ) : (
            <span className="h-20" aria-hidden />
          )}
          <span className="w-full truncate">{f.label}</span>
        </button>
      ))}
    </div>
  );
}

/** The photos picked so far; a tap puts one in the frame (numbered in order) or takes it out. */
function PhotoGrid({
  photos,
  selected,
  onToggle,
}: {
  photos: ComposeImage[];
  selected: number[];
  onToggle: (index: number) => void;
}) {
  const urls = useMemo(
    () =>
      photos.map((p) => {
        const canvas = p.source as HTMLCanvasElement;
        return "toDataURL" in canvas ? canvas.toDataURL("image/jpeg", 0.6) : "";
      }),
    [photos],
  );
  return (
    <div className="grid grid-cols-3 gap-2" data-testid="mobile-photos">
      {photos.map((_, i) => {
        const order = selected.indexOf(i);
        return (
          <button
            key={i}
            type="button"
            aria-pressed={order >= 0}
            aria-label={order >= 0 ? BOOTH.select.unchoose(order + 1) : `사진 ${i + 1} 넣기`}
            data-testid={`mobile-photo-${i}`}
            data-order={order >= 0 ? order + 1 : undefined}
            onClick={() => onToggle(i)}
            className={`relative aspect-[4/3] min-h-12 overflow-hidden rounded-xl ${
              order >= 0 ? "ring-4 ring-ink" : "border border-ink/30"
            }`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- local data URL */}
            <img src={urls[i]} alt="" className="h-full w-full object-cover" />
            {order >= 0 && (
              <span className="absolute left-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-full bg-ink text-base font-bold text-button-text">
                {order + 1}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Steps({ phase }: { phase: Phase["name"] }) {
  const current =
    phase === "frame"
      ? 1
      : phase === "photos" || phase === "preparing" || phase === "error"
        ? 2
        : 3;
  const steps = ["틀 고르기", "사진 고르기", "완성"];
  return (
    // On a narrow phone the three steps do not fit in one row: a step moves to the next row whole
    // (it used to break in the middle of a word).
    <ol className="mt-4 flex flex-wrap justify-center gap-2 text-sm" aria-label="진행 단계">
      {steps.map((s, i) => (
        <li
          key={s}
          aria-current={i + 1 === current ? "step" : undefined}
          className={`whitespace-nowrap rounded-full px-3 py-1 ${
            i + 1 === current
              ? "bg-ink font-bold text-button-text"
              : "border border-ink/40 text-ink/75"
          }`}
        >
          {i + 1}. {s}
        </li>
      ))}
    </ol>
  );
}

/**
 * What the guest should know before answering. Only facts the system enforces are stated;
 * retention periods and the age rule are the church's decision (docs/STATUS.md "14세 미만 기준,
 * 보관 기간 확정") and are deliberately not promised here.
 */
function Notes() {
  return (
    <div className="rounded-3xl border border-ink/15 bg-paper p-5">
      <h3 className="text-lg font-bold text-ink">미디어월에 보내기 전에 읽어 주세요</h3>
      <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-base leading-relaxed text-ink/75">
        <li>이 사진은 크리스마스 마을의 공개된 미디어월에 다른 분들 사진과 함께 보일 수 있어요.</li>
        <li>운영팀이 직접 확인하고 승인한 사진만 걸려요. 승인되지 않을 수도 있어요.</li>
        <li>STUDIO SHALOM 미디어월에만 쓰고, 정해진 보관 기간이 지나면 지워져요.</li>
        <li>다른 사람이 함께 나온 사진은 그분께 먼저 허락을 받아 주세요.</li>
        <li>어린이가 나온 사진은 보호자가 함께 확인한 뒤 보내 주세요.</li>
        <li>사진 속 위치 정보 같은 기록은 지우고 사진만 저장해요.</li>
      </ul>
    </div>
  );
}
