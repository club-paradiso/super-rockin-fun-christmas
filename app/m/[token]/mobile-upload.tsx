"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MOBILE_UPLOAD_CONFIG } from "@/config/mobile";
import { canvasToBlob, createDomCanvas } from "@/lib/canvas";
import {
  CROP_CHOICES,
  decodePhotoFile,
  drawPhoto,
  nextRotation,
  type CropAspect,
  type DecodedPhoto,
  type DecodeFailure,
  type Rotation,
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
    message: "지금은 미디어월 사진 접수를 잠시 멈췄어요. 잠시 뒤 부스에서 다시 시도해 주세요.",
    retry: false,
  },
  closed: { message: "이 QR로 보낸 사진은 이미 처리됐어요.", retry: false },
  too_large: { message: "사진이 너무 커요. 다른 사진을 골라 주세요.", retry: false },
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
  onProgress: (fraction: number) => void,
): Promise<SendOutcome> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/mobile/upload");
    xhr.setRequestHeader("content-type", "image/jpeg");
    xhr.setRequestHeader("x-upload-token", token);
    xhr.setRequestHeader("x-wall-consent", "yes");
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
  expiresAt,
  alreadySent,
}: {
  token: string;
  expiresAt: string;
  alreadySent: boolean;
}) {
  const [phase, setPhase] = useState<Phase>(alreadySent ? { name: "done" } : { name: "pick" });
  const [photo, setPhoto] = useState<DecodedPhoto | null>(null);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [aspect, setAspect] = useState<CropAspect>(null);
  const [preview, setPreview] = useState<{ url: string; blob: Blob } | null>(null);
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

  // Free the decoded bitmap when a new photo replaces it.
  useEffect(() => {
    return () => {
      if (photo && "close" in photo.source) (photo.source as ImageBitmap).close();
    };
  }, [photo]);

  // The JPEG that will be sent, redrawn whenever the guest turns or crops: preview = result.
  useEffect(() => {
    if (!photo) return;
    let cancelled = false;
    (async () => {
      try {
        const canvas = drawPhoto(
          photo,
          rotation,
          aspect,
          MOBILE_UPLOAD_CONFIG.longEdge,
          createDomCanvas,
        ) as HTMLCanvasElement;
        const blob = await canvasToBlob(
          canvas,
          "image/jpeg",
          MOBILE_UPLOAD_CONFIG.clientJpegQuality,
        );
        canvas.width = canvas.height = 0; // let the browser drop the pixels now
        if (cancelled) return;
        setPreview({ url: URL.createObjectURL(blob), blob });
        setPhase((p) => (p.name === "preparing" || p.name === "preview" ? { name: "preview" } : p));
      } catch {
        if (!cancelled) setPhase({ name: "error", ...ERRORS.unreadable! });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [photo, rotation, aspect]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setPhase({ name: "preparing" });
    setRotation(0);
    setAspect(null);
    try {
      setPhoto(await decodePhotoFile(file));
    } catch (failure) {
      const key = (failure as DecodeFailure) === "heic" ? "heic" : "unreadable";
      setPhoto(null);
      setPhase({ name: "error", ...ERRORS[key]! });
    }
  };

  const submit = useCallback(async () => {
    if (!preview || !consent || sending.current) return;
    sending.current = true;
    try {
      for (let attempt = 0; ; attempt++) {
        setPhase({ name: "uploading", progress: 0, attempt });
        const outcome = await send(token, preview.blob, (progress) =>
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
  }, [preview, consent, token]);

  const choose = () => inputRef.current?.click();

  return (
    <main className="night-sky min-h-dvh px-5 pb-12 pt-8" data-testid="mobile-upload">
      <div className="mx-auto flex max-w-md flex-col gap-6">
        <header className="text-center">
          <p className="text-sm tracking-[0.3em] text-amber">FOLLOW THE LIGHTS</p>
          <h1 className="mt-2 text-2xl font-bold text-cream">내 사진으로 참여하기</h1>
          <Steps phase={phase.name} />
        </header>

        <input
          ref={inputRef}
          type="file"
          // image/* lets iPhone hand over a JPEG where it can; HEIC is handled below if not.
          accept="image/*"
          className="sr-only"
          data-testid="mobile-file"
          aria-label="사진 고르기"
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />

        {phase.name === "pick" && (
          <section className="flex flex-col gap-4 text-center">
            <p className="text-lg leading-relaxed text-mist">
              휴대폰에 있는 사진 한 장을 골라 보내면,
              <br />
              운영팀이 확인한 뒤 미디어월에 걸어 드려요.
            </p>
            <button type="button" className="btn-primary w-full" onClick={choose}>
              사진 고르기
            </button>
          </section>
        )}

        {phase.name === "preparing" && (
          <p className="text-center text-lg text-mist" role="status">
            사진을 준비하고 있어요…
          </p>
        )}

        {(phase.name === "preview" || phase.name === "uploading") && preview && (
          <section className="flex flex-col gap-5">
            <figure className="flex justify-center rounded-2xl bg-ink/60 p-3">
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
                <div
                  className="flex flex-wrap justify-center gap-2"
                  role="group"
                  aria-label="자르기"
                >
                  {CROP_CHOICES.map((c) => (
                    <button
                      key={c.label}
                      type="button"
                      aria-pressed={aspect === c.aspect}
                      onClick={() => setAspect(c.aspect)}
                      className={`min-h-12 rounded-full px-4 text-base font-semibold ${
                        aspect === c.aspect
                          ? "bg-amber text-ink"
                          : "border border-cream/30 text-cream"
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setRotation(nextRotation)}
                    className="min-h-12 rounded-full border border-cream/30 px-4 text-base font-semibold text-cream"
                    data-testid="mobile-rotate"
                  >
                    ↻ 돌리기
                  </button>
                </div>
                <Consent checked={consent} onChange={setConsent} />
                <button
                  type="button"
                  className="btn-primary w-full"
                  data-testid="mobile-submit"
                  disabled={!consent}
                  onClick={() => void submit()}
                >
                  미디어월로 보내기
                </button>
                <button type="button" className="btn-quiet self-center" onClick={choose}>
                  다른 사진 고르기
                </button>
              </>
            )}
            {phase.name === "uploading" && (
              <div role="status" className="flex flex-col gap-3 text-center">
                <p className="text-lg text-cream" data-testid="mobile-uploading">
                  {phase.attempt > 0 ? "다시 보내고 있어요…" : "보내고 있어요…"}
                </p>
                <div
                  className="h-3 overflow-hidden rounded-full bg-ink"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(phase.progress * 100)}
                  aria-label="보내는 중"
                >
                  <div
                    className="h-full bg-amber transition-[width]"
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
            <h2 className="text-2xl font-bold text-cream">사진을 받았어요</h2>
            <p className="text-lg leading-relaxed text-mist">
              운영팀이 확인하고 있어요. 확인이 끝나면 미디어월에 걸려요.
              <br />
              <strong className="text-amber">아직 미디어월에 나온 것은 아니에요.</strong>
            </p>
            <p className="text-base text-mist">
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
            <h2 className="text-xl font-bold text-cream">보내지 못했어요</h2>
            <p className="text-lg leading-relaxed text-mist">{phase.message}</p>
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
            <h2 className="text-xl font-bold text-cream">이 QR은 시간이 지났어요</h2>
            <p className="text-lg leading-relaxed text-mist">
              포토부스에서 &lsquo;내 사진으로 참여하기&rsquo;를 다시 눌러 새 QR을 받아 주세요.
            </p>
          </section>
        )}
      </div>
    </main>
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
  const steps = ["사진 고르기", "확인하고 보내기", "운영팀 확인"];
  return (
    <ol className="mt-4 flex justify-center gap-2 text-sm" aria-label="진행 단계">
      {steps.map((s, i) => (
        <li
          key={s}
          aria-current={i + 1 === current ? "step" : undefined}
          className={`rounded-full px-3 py-1 ${
            i + 1 === current ? "bg-amber font-bold text-ink" : "bg-ink/60 text-mist"
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
function Consent({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="rounded-2xl border border-cream/15 bg-ink/60 p-4">
      <h2 className="text-lg font-bold text-cream">보내기 전에 꼭 읽어 주세요</h2>
      <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-base leading-relaxed text-mist">
        <li>이 사진은 크리스마스 마을의 공개된 미디어월에 다른 분들 사진과 함께 보일 수 있어요.</li>
        <li>운영팀이 직접 확인하고 승인한 사진만 걸려요. 승인되지 않을 수도 있어요.</li>
        <li>FOLLOW THE LIGHTS 미디어월에만 쓰고, 정해진 보관 기간이 지나면 지워져요.</li>
        <li>다른 사람이 함께 나온 사진은 그분께 먼저 허락을 받아 주세요.</li>
        <li>어린이가 나온 사진은 보호자가 함께 확인한 뒤 보내 주세요.</li>
        <li>사진 속 위치 정보 같은 기록은 지우고 사진만 저장해요.</li>
      </ul>
      <label className="mt-4 flex min-h-12 cursor-pointer items-center gap-3 text-base font-semibold text-cream">
        <input
          type="checkbox"
          className="h-6 w-6 shrink-0 accent-amber"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          data-testid="mobile-consent"
        />
        위 내용을 확인했고, 미디어월에 보내는 데 동의해요
      </label>
    </div>
  );
}
