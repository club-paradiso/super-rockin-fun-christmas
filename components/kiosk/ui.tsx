"use client";

import { useEffect, useRef } from "react";
import { BrandLockup, BrandWordmark } from "@/components/brand";
import { useAssetReady } from "@/components/studio/stamp-ticket";
import { STUDIO_ASSETS } from "@/config/studio";
import type { CameraEngine } from "@/lib/camera-engine/engine";
import { boothSound } from "@/lib/kiosk/sound";
import { BoothFooter, useKioskChrome, useKioskCopy } from "./chrome";
import { KioskFullscreenControl } from "./fullscreen";

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
  sound: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
    </>
  ),
  muted: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      <path d="M16 9.5l5 5M21 9.5l-5 5" />
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

/**
 * The booth's filled button as a camera release (public/studio/shutter-button.png): a brass and
 * leather knob that sinks when pressed, its shadow shrinking under the top-left light. Without
 * the picture the knob is drawn in CSS. Still the one `.booth-btn-primary` of its screen, with
 * the same label and touch size.
 */
export function ShutterButton({
  label,
  testId,
  onClick,
}: {
  label: string;
  testId: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const art = useAssetReady(STUDIO_ASSETS.shutter);
  return (
    <button
      type="button"
      className="booth-btn-primary shutter-btn"
      data-testid={testId}
      data-art={art ? "image" : "drawn"}
      onClick={(event) => {
        boothSound().play("press");
        onClick(event);
      }}
    >
      <span className="shutter-knob" aria-hidden>
        {art && (
          // eslint-disable-next-line @next/next/no-img-element -- fixed small asset
          <img src={STUDIO_ASSETS.shutter} alt="" draggable={false} className="shutter-knob-img" />
        )}
      </span>
      <span className="shutter-label">{label}</span>
    </button>
  );
}

/**
 * "●○○○○○" (v2, Figma 898:1677: dots only, no "1 / 6"). Done steps are accent, the current one
 * is the dark button colour. The count is kept for screen readers only.
 */
export function Stepper({ step, total }: { step: number; total: number }) {
  const t = useKioskCopy();
  return (
    <div className="booth-steps" aria-label={t.steps.of(step, total)}>
      <span className="booth-steps-count sr-only" data-testid="step-progress">
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

/**
 * One booth screen: header (wordmark, progress), the letter sheet, footer (way home, way back). The sheet
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
  action,
}: {
  children: React.ReactNode;
  testId: string;
  progress?: { step: number; total: number } | null;
  className?: string;
  /**
   * 「틀 선택 v2」 screens (Figma 898:1677 ff.): the screen's main button sits in the fixed bottom
   * bar beside "처음으로", and the screen scales from the 768 × 1024 Figma frame.
   */
  action?: React.ReactNode;
  /** Press the wax seal on this sheet's corner (D79, D80: the attract screen and the QR only). */
  seal?: boolean;
  /** The attract and welcome screens have no header and no footer: the sheet is the screen. */
  header?: boolean;
  onClick?: () => void;
}) {
  const chrome = useKioskChrome();
  const showHeader = header && progress;
  return (
    <section
      data-testid={testId}
      className={`booth-screen ${action ? "booth-screen-v2" : ""} ${onClick ? "cursor-pointer" : ""}`}
      onClick={onClick}
    >
      {showHeader && (
        <header className="booth-header">
          {/* "이전" is in the footer, beside "처음으로" (2026-11-25). */}
          <div className="booth-header-left">
            <BrandWordmark className="booth-wordmark" />
          </div>
          {progress && <Stepper step={progress.step} total={progress.total} />}
        </header>
      )}
      <LetterSheet
        seal={seal}
        className={className}
        chapter={progress?.step ?? (testId === "screen-welcome" ? 1 : undefined)}
      >
        {children}
      </LetterSheet>
      {header && <BoothFooter action={action} />}
      {!header && (
        <div className="kiosk-fullscreen-corner">
          <KioskFullscreenControl lang={chrome?.lang ?? "ko"} />
        </div>
      )}
    </section>
  );
}

/**
 * A ring-bound memory journal replaces the old envelope motif. Keep the LetterSheet export and
 * test ID for compatibility with the kiosk's existing screen and camera layouts. All book parts
 * are decoration: they cannot take focus, intercept a touch, or change the scroll dimensions.
 */
export function LetterSheet({
  children,
  className = "",
  seal = false,
  chapter,
}: {
  children: React.ReactNode;
  className?: string;
  seal?: boolean;
  chapter?: number;
}) {
  return (
    <div className={`letter-sheet journal-sheet ${className}`} data-testid="letter-sheet">
      <span className="journal-spine" data-testid="journal-spine" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <span key={index} className="journal-ring" />
        ))}
      </span>
      {chapter !== undefined && (
        <span className="journal-tab" aria-hidden="true">
          {String(chapter).padStart(2, "0")}
        </span>
      )}
      {children}
      {seal && <JournalBookmark />}
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

/** A paper bookmark, not a wax seal. Decorative and never an overlay on QR pixels or buttons. */
export function JournalBookmark() {
  return <span aria-hidden="true" data-testid="journal-bookmark" className="journal-bookmark" />;
}

/**
 * Live camera preview. Same aspect box + object-fit: cover + mirror flag as the capture code,
 * so the guest sees exactly the crop that will be saved. The box takes its size from the stage
 * it sits in (.shoot-stage): as wide and as tall as the stage allows, always `aspect`. Turning
 * the tablet changes the stage, never the ratio.
 *
 * With 「카메라 자동 보정」 on (`engine`) the <video> is given the photo's own correction as a
 * CSS matrix (lib/camera-engine/preview.ts): the browser's compositor applies it, nothing is
 * drawn by script while the camera runs. Without an engine, or when it has nothing to correct,
 * the element is exactly as above.
 */
export function CameraPreview({
  stream,
  aspect,
  mirror,
  lookView = null,
  engine = null,
  children,
}: {
  stream: MediaStream | null;
  aspect: number;
  mirror: boolean;
  /** A black-and-white frame with looks on shows the live picture that way (lib/looks/config.ts). */
  lookView?: "mono" | "sepia" | null;
  /** The camera engine while staff have it on. */
  engine?: CameraEngine | null;
  children?: React.ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
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

  // The correction is written straight onto the element: it changes when the booth is moved,
  // not with React's renders, and a still booth writes it once.
  useEffect(() => {
    const video = videoRef.current;
    const box = boxRef.current;
    if (!video || !box) return;
    const plain = () => {
      const s = video.style;
      s.position = s.left = s.top = s.width = s.height = "";
      s.maxWidth = s.objectFit = s.transformOrigin = "";
      s.transform = mirror ? "scaleX(-1)" : "";
      delete video.dataset.engine;
    };
    if (!engine) {
      plain();
      return;
    }
    const place = () => {
      const layout = engine.preview(
        video.videoWidth,
        video.videoHeight,
        box.clientWidth,
        box.clientHeight,
        aspect,
        mirror,
      );
      if (!layout) {
        plain();
        return;
      }
      // The whole frame at the size "cover" would give it, so what the correction turns into
      // view from outside the crop is there to be seen; the box clips it.
      const s = video.style;
      s.position = "absolute";
      s.left = `${layout.left}px`;
      s.top = `${layout.top}px`;
      s.width = `${layout.width}px`;
      s.height = `${layout.height}px`;
      s.maxWidth = "none";
      s.objectFit = "fill";
      s.transformOrigin = "0 0";
      s.transform = layout.transform;
      video.dataset.engine = "on";
    };
    place();
    // The engine says when its correction may have changed (the booth was moved, a session
    // began or ended): only this element is touched, React renders nothing.
    const unsubscribe = engine.subscribe(place);
    video.addEventListener("loadedmetadata", place);
    video.addEventListener("resize", place);
    window.addEventListener("resize", place);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    observer?.observe(box);
    return () => {
      unsubscribe();
      video.removeEventListener("loadedmetadata", place);
      video.removeEventListener("resize", place);
      window.removeEventListener("resize", place);
      observer?.disconnect();
      plain();
    };
  }, [engine, stream, aspect, mirror]);

  return (
    <div
      ref={boxRef}
      className="camera-preview"
      data-testid="camera-preview-box"
      style={{ aspectRatio: String(aspect), "--aspect": String(aspect) } as React.CSSProperties}
    >
      {/* muted + playsInline: iOS Safari plays a camera stream inline only with both. */}
      <video
        ref={videoRef}
        data-testid="camera-preview"
        data-look-view={lookView ?? undefined}
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
