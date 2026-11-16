"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { BrandLockup, BrandStarO } from "@/components/brand";
import { STUDIO_ASSETS } from "@/config/studio";
import { createDomCanvas, canvasToBlob } from "@/lib/canvas";
import { formatDateLabel } from "@/lib/compositor";
import { KIOSK_COPY, type KioskLang } from "@/lib/kiosk/copy";
import { drawStampTicket, ticketFileName, ticketFontRequests } from "@/lib/studio/ticket";

// ── Studio pictures (public/studio): used when present, CSS stands in when not ───────────────
// A picture is "ready" only once the browser really loaded it, so a missing file never leaves a
// broken-image box: the CSS look (a drawn ring, a flat kraft colour) simply stays.

const assetState = new Map<string, "loading" | "ok" | "missing">();
const assetListeners = new Set<() => void>();
const subscribeAssets = (listener: () => void) => {
  assetListeners.add(listener);
  return () => assetListeners.delete(listener);
};

function requestAsset(src: string) {
  if (assetState.has(src) || typeof Image === "undefined") return;
  assetState.set(src, "loading");
  const img = new Image();
  const done = (state: "ok" | "missing") => {
    assetState.set(src, state);
    for (const listener of assetListeners) listener();
  };
  img.onload = () => done("ok");
  img.onerror = () => done("missing");
  img.src = src;
}

/** True once `src` has loaded in this browser. False on the server, while loading, and if missing. */
export function useAssetReady(src: string): boolean {
  useEffect(() => requestAsset(src), [src]);
  return useSyncExternalStore(
    subscribeAssets,
    () => assetState.get(src) === "ok",
    () => false,
  );
}

/** A loaded picture for the canvas, or null (missing, or no browser). Never rejects. */
export function loadImage(src: string): Promise<HTMLImageElement | null> {
  if (typeof Image === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// ── The stamp ─────────────────────────────────────────────────────────────────────────────────

/**
 * An ink stamp: the ring (public/studio/stamp-mark.png, or a drawn double ring without it) with
 * the brand in its centre. `large`: the stacked lockup (D73); `small`: the O with its star (D77).
 * Decoration; the ticket around it carries the accessible text.
 */
export function StampMark({ size }: { size: "large" | "small" }) {
  const ink = useAssetReady(STUDIO_ASSETS.stamp);
  return (
    <span
      className={`stamp-mark stamp-mark-${size}`}
      data-ink={ink ? "image" : "drawn"}
      data-testid="stamp-mark"
      aria-hidden
    >
      {ink && (
        // eslint-disable-next-line @next/next/no-img-element -- fixed small asset
        <img src={STUDIO_ASSETS.stamp} alt="" draggable={false} className="stamp-mark-ink" />
      )}
      <span className="stamp-mark-center">
        {size === "large" ? <BrandLockup /> : <BrandStarO />}
      </span>
    </span>
  );
}

export interface TicketInfo {
  /** "오늘 N번째 기록"; null = unknown (the ticket says "오늘의 기록"). */
  ordinal: number | null;
  /** When the photo was made (any ISO time); its Seoul date is printed. */
  createdAt: string | Date;
}

function ticketText(info: TicketInfo, lang: KioskLang) {
  const t = KIOSK_COPY[lang];
  return {
    date: formatDateLabel(new Date(info.createdAt)),
    record: info.ordinal ? t.ticket.dayOrdinal(info.ordinal) : t.ticket.dayRecord,
    event: KIOSK_COPY.ko.attract.event,
  };
}

/**
 * The booth's line on the QR ticket: a small stamp, the record number, the date. Fits under the
 * QR without taking its room.
 */
export function TicketStampLine({ info, lang }: { info: TicketInfo; lang: KioskLang }) {
  const text = ticketText(info, lang);
  return (
    <div className="ticket-line" data-testid="ticket-line">
      <StampMark size="small" />
      <p className="ticket-line-text">
        <span className="ticket-line-record" data-testid="ticket-record">
          {text.record}
        </span>
        <span className="ticket-line-date">{text.date}</span>
      </p>
    </div>
  );
}

/** Teeth along the top and bottom of a paper ticket (a torn receipt), as a clip-path. */
export function zigzagClip(teeth: number, depthPx: number): string {
  const step = 100 / teeth;
  const top: string[] = [`0 ${depthPx}px`];
  const bottom: string[] = [`100% calc(100% - ${depthPx}px)`];
  for (let i = 0; i < teeth; i++) {
    top.push(`${(step * (i + 0.5)).toFixed(3)}% 0`, `${(step * (i + 1)).toFixed(3)}% ${depthPx}px`);
    const j = teeth - i;
    bottom.push(
      `${(step * (j - 0.5)).toFixed(3)}% 100%`,
      `${(step * (j - 1)).toFixed(3)}% calc(100% - ${depthPx}px)`,
    );
  }
  return `polygon(${[...top, ...bottom].join(", ")})`;
}
const PHONE_TICKET_CLIP = zigzagClip(18, 9);

/**
 * The guest's stamp ticket on the phone pages (/p/[token], /m/[token]): STUDIO SHALOM, today's
 * date and "오늘 N번째 기록", with a button that saves it as a 1080 × 1920 PNG for a story.
 */
export function StampTicket({ info, lang = "ko" }: { info: TicketInfo; lang?: KioskLang }) {
  const text = ticketText(info, lang);
  return (
    <div className="flex w-full flex-col items-center gap-4" data-testid="stamp-ticket">
      <div className="stamp-ticket-shadow">
        <section
          className="stamp-ticket"
          style={{ clipPath: PHONE_TICKET_CLIP }}
          aria-label={`STUDIO SHALOM · ${text.date} · ${text.record}`}
        >
          <StampMark size="large" />
          <p className="stamp-ticket-date" aria-hidden>
            {text.date}
          </p>
          <p className="stamp-ticket-record" data-testid="ticket-record" aria-hidden>
            {text.record}
          </p>
          <span className="stamp-ticket-perforation" aria-hidden />
          <p className="stamp-ticket-event" aria-hidden>
            {text.event}
          </p>
        </section>
      </div>
      <SaveTicketButton info={info} lang={lang} />
    </div>
  );
}

const noSubscribe = () => () => {};

/**
 * Saves the ticket as a PNG: the share sheet where the phone has one (iPhone: "이미지 저장"),
 * a download otherwise. The picture is drawn on the phone; nothing is sent anywhere.
 */
export function SaveTicketButton({ info, lang = "ko" }: { info: TicketInfo; lang?: KioskLang }) {
  const shareApi = useSyncExternalStore(
    noSubscribe,
    () => typeof navigator.canShare === "function" && typeof navigator.share === "function",
    () => false,
  );
  const [file, setFile] = useState<File | null>(null);
  const [failed, setFailed] = useState(false);
  const { ordinal } = info;
  const createdAt = new Date(info.createdAt).toISOString();

  // Drawn ahead of the tap: Safari only allows share() right after a touch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const text = ticketText({ ordinal, createdAt }, lang);
        if (typeof document !== "undefined" && document.fonts) {
          await Promise.all(
            ticketFontRequests(text).map((r) =>
              document.fonts.load(r.spec, r.text).catch(() => []),
            ),
          );
        }
        const [lockup, stamp] = await Promise.all([
          loadImage(STUDIO_ASSETS.lockup),
          loadImage(STUDIO_ASSETS.stamp),
        ]);
        const canvas = drawStampTicket(createDomCanvas, text, { lockup, stamp });
        const blob = await canvasToBlob(canvas as HTMLCanvasElement, "image/png");
        if (!cancelled)
          setFile(new File([blob], ticketFileName(text.date, ordinal), { type: "image/png" }));
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ordinal, createdAt, lang]);

  async function save() {
    if (!file) return;
    if (shareApi && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  if (failed) return null;
  return (
    <button
      type="button"
      className="btn-secondary w-full"
      data-testid="save-ticket"
      disabled={!file}
      onClick={() => void save()}
    >
      기록 티켓 이미지로 저장
    </button>
  );
}
