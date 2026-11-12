"use client";

import { useEffect, useRef } from "react";
import { BrandLockup, BrandWordmark } from "@/components/brand";
import type { EasyStepKey } from "@/lib/kiosk/copy";
import { BoothFooter, useKioskChrome, useKioskCopy } from "./chrome";

/** Full-screen stage every kiosk screen sits on. */
export function Stage({
  children,
  testId,
  className = "",
}: {
  children: React.ReactNode;
  testId: string;
  className?: string;
}) {
  return (
    <section
      data-testid={testId}
      className={`flex min-h-dvh w-full flex-col items-center justify-center gap-8 px-8 py-10 text-center ${className}`}
    >
      {children}
    </section>
  );
}

export { BrandLockup, BrandWordmark };

/**
 * Line icons for the booth (same drawings as the Figma Icon components). They take the text
 * colour and the font size of where they sit; decorative, so hidden from assistive tech.
 */
const LINE_ICONS = {
  camera: (
    <>
      <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.3l1.4-2h7.6l1.4 2h2.3A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-9Z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2" />
      <path d="M11 17.5h2" />
    </>
  ),
} as const;

export function LineIcon({ name }: { name: keyof typeof LINE_ICONS }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {LINE_ICONS[name]}
    </svg>
  );
}

/** "3 / 6 ●●●○○○". Done steps are accent, the current one is the dark button colour. */
export function Stepper({ step, total }: { step: number; total: number }) {
  const t = useKioskCopy();
  return (
    <div className="flex items-center gap-[14px]" aria-label={t.steps.of(step, total)}>
      <span className="font-mono text-xl tracking-[0.08em] text-ink" data-testid="step-progress">
        {step} / {total}
      </span>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className={`h-4 w-4 rounded-full ${
            i + 1 === step ? "bg-button" : i + 1 < step ? "bg-accent" : "bg-ink/20"
          }`}
        />
      ))}
    </div>
  );
}

/** Easy mode: "2 / 6단계 · 사진 확인" in words, large, with a progress bar. */
export function EasyStep({
  step,
  total,
  stepKey,
}: {
  step: number;
  total: number;
  stepKey: EasyStepKey;
}) {
  const t = useKioskCopy();
  return (
    <div className="flex flex-col items-end gap-2" data-testid="easy-step">
      <p className="text-[clamp(24px,3.4vh,38px)] font-bold text-ink">
        <span className="text-accent">{t.steps.easy(step)}</span> · {t.steps.labels[stepKey]}
        <span className="sr-only"> ({t.steps.of(step, total)})</span>
      </p>
      <div className="h-3 w-[min(36vw,320px)] overflow-hidden rounded-full bg-ink/20" aria-hidden>
        <div className="h-full bg-button" style={{ width: `${(step / total) * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * Full-screen booth screen on the flat paper backdrop: the wordmark top left and the step dots
 * top right (none on the attract screen).
 */
export function BoothScreen({
  children,
  testId,
  progress,
  className = "",
  seal = false,
}: {
  children: React.ReactNode;
  testId: string;
  progress?: { step: number; total: number } | null;
  className?: string;
  /** Press the wax seal on this sheet's corner (D79, D80: the attract screen and the QR only). */
  seal?: boolean;
}) {
  const chrome = useKioskChrome();
  const easy = chrome?.mode === "easy";
  const back = chrome?.goBack ?? null;
  return (
    <section
      data-testid={testId}
      className="relative flex min-h-dvh w-full flex-col px-[max(24px,4.2vw)] pb-[max(20px,3vh)] pt-[max(20px,4.4vh)]"
    >
      {(progress || back || (easy && chrome?.easyStep)) && (
        <header className="flex min-h-[max(56px,7.4vh)] items-center justify-between gap-4">
          <div className="flex items-center gap-[max(16px,2vw)]">
            {/* One step back, where nothing the guest made is lost (D78). */}
            {back && (
              <button
                type="button"
                className={`booth-chrome-btn ${easy ? "booth-chrome-btn-easy" : ""}`}
                onClick={back}
                data-testid="go-back"
              >
                <span aria-hidden>‹</span> {chrome!.t.chrome.back}
              </button>
            )}
            <BrandWordmark className="text-[clamp(20px,2.8vh,30px)]" />
          </div>
          {easy && chrome?.easyStep ? (
            <EasyStep
              step={chrome.easyStep.step}
              total={chrome.easyStep.total}
              stepKey={chrome.easyStep.key}
            />
          ) : (
            progress && <Stepper step={progress.step} total={progress.total} />
          )}
        </header>
      )}
      <LetterSheet
        seal={seal}
        className={`flex flex-1 flex-col items-center justify-center ${className}`}
      >
        {children}
      </LetterSheet>
      <BoothFooter />
    </section>
  );
}

/**
 * The letter sheet (D79): every booth screen's content sits on one sheet of paper on the
 * backdrop. Layout classes go to the sheet itself, so screens keep their own arrangement.
 */
export function LetterSheet({
  children,
  className = "",
  seal = false,
}: {
  children: React.ReactNode;
  className?: string;
  seal?: boolean;
}) {
  return (
    <div className={`letter-sheet ${className}`} data-testid="letter-sheet">
      {children}
      {seal && <WaxSeal />}
    </div>
  );
}

/** Decoration only: no text, not focusable, never in the way of a touch. */
export function WaxSeal() {
  return (
    // A fixed 27 KB asset at one size; next/image would add nothing here.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/wax-seal.webp"
      alt=""
      aria-hidden
      draggable={false}
      data-testid="wax-seal"
      className="wax-seal"
    />
  );
}

export function Title({ children }: { children: React.ReactNode }) {
  return <h1 className="text-4xl font-bold leading-tight text-ink md:text-5xl">{children}</h1>;
}

export function Lead({ children }: { children: React.ReactNode }) {
  return <p className="max-w-2xl text-2xl leading-relaxed text-ink/75">{children}</p>;
}

/** "●●○○  2 / 4" — always visible while shooting so nobody wonders how many are left. */
export function ShotProgress({ done, total }: { done: number; total: number }) {
  return (
    <div className="flex items-center gap-4" aria-label={`${total}장 중 ${done}장 촬영`}>
      <div className="flex gap-3">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={`h-5 w-5 rounded-full border-2 border-ink ${i < done ? "bg-ink" : "bg-transparent"}`}
          />
        ))}
      </div>
      <span className="text-2xl font-semibold tabular-nums text-ink" data-testid="shot-progress">
        {done} / {total}
      </span>
    </div>
  );
}

/**
 * Live camera preview. Same aspect box + object-fit: cover + mirror flag as the capture code,
 * so the guest sees exactly the crop that will be saved.
 */
export function CameraPreview({
  stream,
  aspect,
  mirror,
  children,
}: {
  stream: MediaStream | null;
  aspect: number;
  mirror: boolean;
  children?: React.ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const t = useKioskCopy();

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    if (stream) video.play().catch(() => undefined);
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  return (
    <div
      className="relative w-full max-w-[min(90vw,calc(62dvh*4/3))] overflow-hidden rounded-3xl border border-ink/20 bg-ink/10"
      style={{ aspectRatio: String(aspect) }}
    >
      <video
        ref={videoRef}
        data-testid="camera-preview"
        muted
        playsInline
        autoPlay
        className="h-full w-full object-cover"
        style={{ transform: mirror ? "scaleX(-1)" : undefined }}
      />
      {!stream && (
        <div className="absolute inset-0 flex items-center justify-center text-xl text-ink/75">
          {t.camera.preview}
        </div>
      )}
      {children}
    </div>
  );
}
