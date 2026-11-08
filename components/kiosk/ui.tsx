"use client";

import { useEffect, useRef } from "react";
import { BoothFooter, useKioskChrome } from "./chrome";

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
      className={`night-sky flex min-h-dvh w-full flex-col items-center justify-center gap-8 px-8 py-10 text-center ${className}`}
    >
      {children}
    </section>
  );
}

/** The event wordmark exported from Figma (Brand/Lockup), shared with the Navy Strip frame. */
export function BrandLockup({ className = "" }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- static SVG, same origin, works offline
  return <img src="/frames/navy-lockup.svg" alt="FOLLOW THE LIGHTS" className={className} />;
}

/** "3 / 6 ●●●○○○" — Figma Booth/Stepper. Done steps glow, the current one is gold. */
export function Stepper({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex items-center gap-[14px]" aria-label={`${total}단계 중 ${step}단계`}>
      <span className="font-mono text-xl tracking-[0.08em] text-warm" data-testid="step-progress">
        {step} / {total}
      </span>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className={`h-4 w-4 rounded-full ${
            i + 1 === step ? "bg-gold" : i + 1 < step ? "bg-warm" : "bg-warm/20"
          }`}
        />
      ))}
    </div>
  );
}

/** Easy mode: "2 / 6단계 · 사진 확인" in words, large, with a progress bar. */
export function EasyStep({ step, total, label }: { step: number; total: number; label: string }) {
  return (
    <div className="flex flex-col items-end gap-2" data-testid="easy-step">
      <p className="text-[clamp(24px,3.4vh,38px)] font-bold text-glow">
        <span className="text-gold">{step}단계</span> · {label}
        <span className="sr-only">
          {" "}
          ({total}단계 중 {step}단계)
        </span>
      </p>
      <div className="h-3 w-[min(36vw,320px)] overflow-hidden rounded-full bg-navy-700" aria-hidden>
        <div className="h-full bg-gold" style={{ width: `${(step / total) * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * Full-screen booth screen from the Figma 01 Platform frames: the night glow, the wordmark top
 * left and the step dots top right (none on the attract screen).
 */
export function BoothScreen({
  children,
  testId,
  progress,
  className = "",
}: {
  children: React.ReactNode;
  testId: string;
  progress?: { step: number; total: number } | null;
  className?: string;
}) {
  const chrome = useKioskChrome();
  const easy = chrome?.mode === "easy";
  return (
    <section
      data-testid={testId}
      className="booth-sky relative flex min-h-dvh w-full flex-col px-[max(24px,4.2vw)] pb-[max(20px,3vh)] pt-[max(20px,4.4vh)]"
    >
      {(progress || (easy && chrome?.easyStep)) && (
        <header className="flex min-h-[max(56px,7.4vh)] items-center justify-between gap-4">
          <BrandLockup className="h-[max(36px,4.6vh)] w-auto" />
          {easy && chrome?.easyStep ? (
            <EasyStep {...chrome.easyStep} />
          ) : (
            progress && <Stepper step={progress.step} total={progress.total} />
          )}
        </header>
      )}
      <div className={`flex flex-1 flex-col items-center justify-center ${className}`}>
        {children}
      </div>
      <BoothFooter />
    </section>
  );
}

export function Title({ children }: { children: React.ReactNode }) {
  return <h1 className="text-4xl font-bold leading-tight text-cream md:text-5xl">{children}</h1>;
}

export function Lead({ children }: { children: React.ReactNode }) {
  return <p className="max-w-2xl text-2xl leading-relaxed text-mist">{children}</p>;
}

/** "●●○○  2 / 4" — always visible while shooting so nobody wonders how many are left. */
export function ShotProgress({ done, total }: { done: number; total: number }) {
  return (
    <div className="flex items-center gap-4" aria-label={`${total}장 중 ${done}장 촬영`}>
      <div className="flex gap-3">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={`h-5 w-5 rounded-full border-2 border-amber ${i < done ? "bg-amber" : "bg-transparent"}`}
          />
        ))}
      </div>
      <span className="text-2xl font-semibold tabular-nums text-cream" data-testid="shot-progress">
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
      className="relative w-full max-w-[min(90vw,calc(62dvh*4/3))] overflow-hidden rounded-3xl border-2 border-amber/30 bg-night shadow-[0_0_80px_rgba(255,207,138,0.12)]"
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
        <div className="absolute inset-0 flex items-center justify-center text-xl text-mist">
          미리보기를 준비하고 있어요…
        </div>
      )}
      {children}
    </div>
  );
}
