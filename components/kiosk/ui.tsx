"use client";

import { useEffect, useRef } from "react";
import { BrandLockup, BrandWordmark } from "@/components/brand";
import type { EasyStepKey } from "@/lib/kiosk/copy";
import { BoothFooter, useKioskChrome, useKioskCopy } from "./chrome";

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
  /** "More below": shown only when a screen is taller than the booth. */
  down: <path d="M6 9l6 6 6-6" />,
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
    <div className="booth-steps" aria-label={t.steps.of(step, total)}>
      <span className="booth-steps-count" data-testid="step-progress">
        {step} / {total}
      </span>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className={`booth-steps-dot ${
            i + 1 === step ? "booth-steps-dot-now" : i + 1 < step ? "booth-steps-dot-done" : ""
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
    <div className="booth-easy-step" data-testid="easy-step">
      <p className="booth-easy-step-label">
        <span className="text-accent">{t.steps.easy(step)}</span> · {t.steps.labels[stepKey]}
        <span className="sr-only"> ({t.steps.of(step, total)})</span>
      </p>
      <div className="booth-easy-step-bar" aria-hidden>
        <div className="h-full bg-button" style={{ width: `${(step / total) * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * One booth screen: header (way back, wordmark, progress), the letter sheet, footer. The sheet
 * takes the height that is left; `className` lays out what is on it (see "Screens" in
 * app/globals.css). The screen fills the booth and grows only when its content cannot fit, in
 * which case the booth's scroll area scrolls.
 */
export function BoothScreen({
  children,
  testId,
  progress,
  className = "sheet-center",
  seal = false,
  header = true,
  onClick,
}: {
  children: React.ReactNode;
  testId: string;
  progress?: { step: number; total: number } | null;
  className?: string;
  /** Press the wax seal on this sheet's corner (D79, D80: the attract screen and the QR only). */
  seal?: boolean;
  /** The attract and welcome screens have no header and no footer: the sheet is the screen. */
  header?: boolean;
  onClick?: () => void;
}) {
  const chrome = useKioskChrome();
  const easy = chrome?.mode === "easy";
  const back = chrome?.goBack ?? null;
  const showHeader = header && (progress || back || (easy && chrome?.easyStep));
  return (
    <section
      data-testid={testId}
      className={`booth-screen ${onClick ? "cursor-pointer" : ""}`}
      onClick={onClick}
    >
      {showHeader && (
        <header
          className={`booth-header ${easy ? "booth-header-easy" : ""} ${back ? "booth-header-back" : ""}`}
        >
          <div className="booth-header-left">
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
            <BrandWordmark className="booth-wordmark" />
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
      <LetterSheet seal={seal} className={className}>
        {children}
      </LetterSheet>
      {header && <BoothFooter />}
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
      <Tape side="left" />
      <Tape side="right" />
      {children}
      {seal && <WaxSeal />}
    </div>
  );
}

/** A strip of masking tape (D81). Decoration only: no text, no touch, never over a button. */
export function Tape({ side }: { side: "left" | "right" | "center" }) {
  return <span aria-hidden className={`tape tape-${side}`} data-testid="tape" />;
}

/** Album photo corners (D81) around a print. Decoration only. */
export function PhotoCorners() {
  return (
    <>
      {(["tl", "tr", "bl", "br"] as const).map((c) => (
        <span key={c} aria-hidden className={`photo-corner photo-corner-${c}`} />
      ))}
    </>
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

/**
 * Live camera preview. Same aspect box + object-fit: cover + mirror flag as the capture code,
 * so the guest sees exactly the crop that will be saved. The box takes its size from the stage
 * it sits in (.shoot-stage): as wide and as tall as the stage allows, always `aspect`. Turning
 * the tablet changes the stage, never the ratio.
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
      className="camera-preview"
      data-testid="camera-preview-box"
      style={{ aspectRatio: String(aspect), "--aspect": String(aspect) } as React.CSSProperties}
    >
      {/* muted + playsInline: iOS Safari plays a camera stream inline only with both. */}
      <video
        ref={videoRef}
        data-testid="camera-preview"
        muted
        playsInline
        autoPlay
        disablePictureInPicture
        className="h-full w-full object-cover"
        style={{ transform: mirror ? "scaleX(-1)" : undefined }}
      />
      {!stream && <div className="camera-preview-wait">{t.camera.preview}</div>}
      <PhotoCorners />
      {children}
    </div>
  );
}
