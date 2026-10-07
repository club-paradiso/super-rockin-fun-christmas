"use client";

import { useEffect, useRef } from "react";

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
