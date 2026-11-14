"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrandLockup } from "@/components/brand";
import { FRAMES, getFrame } from "@/config/frames";
import { KIOSK_CONFIG } from "@/config/kiosk";
import { MOBILE_UPLOAD_CONFIG, mobileFramesFor } from "@/config/mobile";
import { canvasToBlob, createDomCanvas } from "@/lib/canvas";
import { loadFrameAssets } from "@/lib/compositor/assets";
import { composeFrame, formatDateLabel } from "@/lib/compositor/compose";
import { loadFrameFonts } from "@/lib/compositor/fonts";
import type { ComposeImage } from "@/lib/compositor/types";
import {
  cycleOrder,
  decodePhotoFile,
  drawPhoto,
  limitPicked,
  type DecodeFailure,
} from "@/lib/mobile/prepare";

type Phase =
  | { name: "pick" }
  | { name: "preparing" }
  | { name: "preview" }
  | { name: "uploading"; progress: number; attempt: number }
  | { name: "done" }
  | { name: "error"; message: string; retry: boolean }
  | { name: "expired" };

/** Network trouble is retried by itself this many times, with growing waits, before asking. */
const AUTO_RETRIES = [1_000, 3_000, 7_000];

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
  consent: { message: "동의 확인란을 눌러 주세요.", retry: false },
  paused: {
    message: "지금은 미디어월 게시 신청을 잠시 멈췄어요. 잠시 뒤 부스에서 다시 시도해 주세요.",
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
      if (xhr.status === 200 || xhr.status === 201) resolve("ok");
      else if (xhr.status === 410) resolve("expired");
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
}: {
  token: string;
  /** Staff have the public wall on: say so in the consent text and send that scope. */
  publicWall: boolean;
  expiresAt: string;
  alreadySent: boolean;
}) {
  const [phase, setPhase] = useState<Phase>(alreadySent ? { name: "done" } : { name: "pick" });
  // The picked photos, already shrunk (MOBILE_UPLOAD_CONFIG.sourceLongEdge), in slot order.
  const [photos, setPhotos] = useState<ComposeImage[]>([]);
  const [dropped, setDropped] = useState(0);
  const [frameId, setFrameId] = useState<string | null>(null);
  const [assets, setAssets] = useState<Map<string, ComposeImage> | null>(null);
  // The encoded picture, with the frame and photo list it was made from: composing is async, so
  // the guest's current choice can be ahead of it for a moment.
  const [preview, setPreview] = useState<{
    url: string;
    blob: Blob;
    frameId: string;
    photos: ComposeImage[];
  } | null>(null);
  const [consent, setConsent] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sending = useRef(false);

  // The QR stops working after its time; say so instead of failing on submit.
  useEffect(() => {
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (phase.name === "done") return;
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
    void Promise.all([loadFrameFonts(FRAMES), loadFrameAssets(FRAMES)]).then(([, loaded]) => {
      if (!cancelled) setAssets(loaded.assets);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Free the shrunk photos' pixels when the page goes away. A new pick frees the old ones itself
  // (`release`); reordering keeps the same canvases, so it must not free anything.
  const photosRef = useRef<ComposeImage[]>([]);
  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);
  useEffect(() => () => release(photosRef.current), []);

  const frames = useMemo(() => mobileFramesFor(photos.length), [photos.length]);
  const dateLabel = useMemo(() => formatDateLabel(new Date()), []);

  // Small pictures of each frame this many photos fit, with the guest's own photos in them.
  const thumbs = useMemo(() => {
    const out: Record<string, string> = {};
    if (!assets || photos.length === 0) return out;
    for (const frame of frames) {
      const canvas = composeFrame(frame, photos, {
        createCanvas: createDomCanvas,
        context: { dateLabel, assets },
        scale: KIOSK_CONFIG.thumbScale / 2,
      }) as HTMLCanvasElement;
      out[frame.id] = canvas.toDataURL("image/jpeg", 0.8);
      canvas.width = canvas.height = 0;
    }
    return out;
  }, [assets, frames, photos, dateLabel]);

  // The JPEG that will be sent: the photos in the chosen frame at the booth's saved size, redrawn
  // whenever the guest changes the frame or the order. Preview = result.
  useEffect(() => {
    if (!assets || !frameId || photos.length === 0) return;
    const frame = getFrame(frameId);
    if (frame.id !== frameId || frame.slots.length !== photos.length) return;
    let cancelled = false;
    (async () => {
      try {
        const canvas = composeFrame(frame, photos, {
          createCanvas: createDomCanvas,
          context: { dateLabel, assets },
          scale: KIOSK_CONFIG.outputScale,
        }) as HTMLCanvasElement;
        const blob = await canvasToBlob(
          canvas,
          "image/jpeg",
          MOBILE_UPLOAD_CONFIG.clientJpegQuality,
        );
        canvas.width = canvas.height = 0; // let the browser drop the pixels now
        if (cancelled) return;
        setPreview({ url: URL.createObjectURL(blob), blob, frameId: frame.id, photos });
        setPhase((p) => (p.name === "preparing" || p.name === "preview" ? { name: "preview" } : p));
      } catch {
        if (!cancelled) setPhase({ name: "error", ...ERRORS.unreadable! });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assets, frameId, photos, dateLabel]);

  const pick = async (list: FileList | null) => {
    const files = list ? [...list] : [];
    if (files.length === 0) return;
    const { kept, dropped: left } = limitPicked(files, MOBILE_UPLOAD_CONFIG.maxPhotos);
    setPhase({ name: "preparing" });
    setPreview(null);
    release(photosRef.current);
    photosRef.current = [];
    setPhotos([]);
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
      const key = (failure as DecodeFailure) === "heic" ? "heic" : "unreadable";
      setPhotos([]);
      setFrameId(null);
      setPhase({ name: "error", ...ERRORS[key]! });
      return;
    }
    setDropped(left);
    setPhotos(shrunk);
    // The first frame in picker order for this many photos, as on the booth.
    setFrameId(mobileFramesFor(shrunk.length)[0]?.id ?? null);
  };

  // Only a picture made from what is on screen now may be sent: never an older frame's picture
  // under the new frame's id (the server would refuse it), never the photos in an older order.
  const previewCurrent = !!preview && preview.frameId === frameId && preview.photos === photos;

  const submit = useCallback(async () => {
    if (!preview || !previewCurrent || !consent || sending.current) return;
    sending.current = true;
    try {
      for (let attempt = 0; ; attempt++) {
        setPhase({ name: "uploading", progress: 0, attempt });
        const outcome = await send(token, preview.blob, preview.frameId, publicWall, (progress) =>
          setPhase({ name: "uploading", progress, attempt }),
        );
        if (outcome === "ok") return setPhase({ name: "done" });
        if (outcome === "expired") return setPhase({ name: "expired" });
        const err = ERRORS[outcome]!;
        if (err.retry && attempt < AUTO_RETRIES.length) {
          await new Promise((r) => setTimeout(r, AUTO_RETRIES[attempt]));
          continue;
        }
        return setPhase({ name: "error", ...err });
      }
    } finally {
      sending.current = false;
    }
  }, [preview, previewCurrent, consent, token, publicWall]);

  const choose = () => inputRef.current?.click();

  return (
    <main className="min-h-dvh px-5 pb-12 pt-8" data-testid="mobile-upload">
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

        {phase.name === "pick" && (
          <section className="flex flex-col gap-4 text-center">
            <p className="text-lg leading-relaxed text-ink/75">
              휴대폰에 있는 사진을 1~6장 골라 포토부스 틀에 담아 보내면,
              <br />
              운영팀이 확인한 뒤 미디어월에 걸어 드려요.
            </p>
            <button type="button" className="btn-primary w-full" onClick={choose}>
              사진 고르기 (최대 6장)
            </button>
          </section>
        )}

        {phase.name === "preparing" && (
          <p className="text-center text-lg text-ink/75" role="status">
            사진을 준비하고 있어요…
          </p>
        )}

        {(phase.name === "preview" || phase.name === "uploading") && preview && (
          <section className="flex flex-col gap-5">
            <figure className="flex justify-center rounded-3xl bg-paper p-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- local object URL */}
              <img
                src={preview.url}
                alt="보낼 사진 미리보기"
                data-testid="mobile-preview"
                className="max-h-[46dvh] w-auto rounded-lg"
              />
            </figure>
            {phase.name === "preview" && (
              <>
                {dropped > 0 && (
                  <p className="text-center text-base text-ink/75" data-testid="mobile-dropped">
                    한 틀에는 6장까지 담겨요. 앞의 6장만 담았어요.
                  </p>
                )}
                <FramePicker
                  frames={frames.map((f) => ({ id: f.id, label: f.label, thumb: thumbs[f.id] }))}
                  selected={frameId}
                  onSelect={setFrameId}
                />
                {photos.length > 1 && (
                  <button
                    type="button"
                    className="min-h-12 self-center rounded-full border border-ink/50 px-5 text-base font-semibold text-ink"
                    data-testid="mobile-reorder"
                    onClick={() => setPhotos(cycleOrder)}
                  >
                    ↻ 사진 순서 바꾸기
                  </button>
                )}
                <Consent checked={consent} onChange={setConsent} publicWall={publicWall} />
                <button
                  type="button"
                  className="btn-primary w-full"
                  data-testid="mobile-submit"
                  disabled={!consent || !previewCurrent}
                  onClick={() => void submit()}
                >
                  미디어월로 보내기
                </button>
                <button type="button" className="btn-quiet self-center" onClick={choose}>
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
              내리고 싶으면 현장 안내 봉사자에게 말씀해 주세요. 이 창은 닫아도 돼요.
            </p>
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
            {phase.retry && preview ? (
              <button type="button" className="btn-primary w-full" onClick={() => void submit()}>
                다시 보내기
              </button>
            ) : (
              <button type="button" className="btn-primary w-full" onClick={choose}>
                다른 사진 고르기
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

/** The booth frames that hold this many photos, each shown with the guest's own photos in it. */
function FramePicker({
  frames,
  selected,
  onSelect,
}: {
  frames: { id: string; label: string; thumb: string | undefined }[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (frames.length < 2) return null;
  return (
    <div
      role="radiogroup"
      aria-label="틀 고르기"
      className="flex flex-wrap justify-center gap-3"
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
          className={`flex min-h-12 w-24 flex-col items-center gap-1 rounded-2xl p-2 text-sm font-semibold text-ink ${
            selected === f.id ? "bg-paper ring-2 ring-ink" : "border border-ink/30"
          }`}
        >
          {f.thumb ? (
            // eslint-disable-next-line @next/next/no-img-element -- local data URL
            <img src={f.thumb} alt="" className="h-20 w-auto object-contain" />
          ) : (
            <span className="h-20" aria-hidden />
          )}
          {f.label}
        </button>
      ))}
    </div>
  );
}

function Steps({ phase }: { phase: Phase["name"] }) {
  const current =
    phase === "pick" || phase === "preparing"
      ? 1
      : phase === "preview"
        ? 2
        : phase === "done"
          ? 3
          : 2;
  const steps = ["사진 고르기", "틀 고르고 보내기", "운영팀 확인"];
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
 * What the guest agrees to. Only facts the system enforces are stated; retention periods and the
 * age rule are the church's decision (docs/STATUS.md "14세 미만 기준, 보관 기간 확정") and are
 * deliberately not promised here.
 */
function Consent({
  checked,
  onChange,
  publicWall,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  publicWall: boolean;
}) {
  return (
    <div className="rounded-3xl border border-ink/15 bg-paper p-5">
      <h2 className="text-lg font-bold text-ink">보내기 전에 꼭 읽어 주세요</h2>
      <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-base leading-relaxed text-ink/75">
        <li>이 사진은 크리스마스 마을의 공개된 미디어월에 다른 분들 사진과 함께 보일 수 있어요.</li>
        {/* D86. Written by Claude (2026-11-13), pending the user's wording. */}
        {publicWall && (
          <li data-testid="mobile-public-note">
            미디어월은 행사장 화면과 온라인 주소에서 함께 보여요.
          </li>
        )}
        <li>운영팀이 직접 확인하고 승인한 사진만 걸려요. 승인되지 않을 수도 있어요.</li>
        <li>STUDIO SHALOM 미디어월에만 쓰고, 정해진 보관 기간이 지나면 지워져요.</li>
        <li>다른 사람이 함께 나온 사진은 그분께 먼저 허락을 받아 주세요.</li>
        <li>어린이가 나온 사진은 보호자가 함께 확인한 뒤 보내 주세요.</li>
        <li>사진 속 위치 정보 같은 기록은 지우고 사진만 저장해요.</li>
      </ul>
      <label className="mt-4 flex min-h-12 cursor-pointer items-center gap-3 text-base font-semibold text-ink">
        <input
          type="checkbox"
          className="h-6 w-6 shrink-0 accent-button"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          data-testid="mobile-consent"
        />
        위 내용을 확인했고, 미디어월에 보내는 데 동의해요
      </label>
    </div>
  );
}
