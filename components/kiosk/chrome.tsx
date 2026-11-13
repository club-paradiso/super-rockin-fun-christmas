"use client";

import { createContext, useContext, useEffect, useId, useRef } from "react";
import type { KioskMode } from "@/lib/storage/types";
import { KIOSK_COPY, type EasyStepKey, type KioskCopy, type KioskLang } from "@/lib/kiosk/copy";

/**
 * What every booth screen shares (release 2.0): the guest's screen mode and the way home.
 * Provided once by KioskApp so screens do not pass it around.
 */
export interface KioskChrome {
  mode: KioskMode;
  /** The guest's language (D78) and its strings. */
  lang: KioskLang;
  t: KioskCopy;
  /** Easy mode: the current step in words ("2단계 · 사진 확인"). */
  easyStep: { step: number; total: number; key: EasyStepKey } | null;
  toggleMode: () => void;
  /** "처음으로": asks first when a session is under way. Null where it makes no sense. */
  goHome: (() => void) | null;
  /** "이전": one step back where nothing is lost (D78). Null where there is no way back. */
  goBack: (() => void) | null;
  /** Hide the footer (while counting down and shooting: nothing to press, nothing to distract). */
  quiet: boolean;
}

export const KioskChromeContext = createContext<KioskChrome | null>(null);
export const useKioskChrome = () => useContext(KioskChromeContext);
/** The guest's booth strings; Korean outside a booth (tests, previews). */
export const useKioskCopy = (): KioskCopy => useContext(KioskChromeContext)?.t ?? KIOSK_COPY.ko;

/**
 * Footer of every booth screen. Standard: two quiet buttons. Easy: the same two, large, high
 * contrast, with a plain, descriptive mode label (WCAG 2.2: target size, visible labels).
 */
export function BoothFooter() {
  const chrome = useKioskChrome();
  if (!chrome || chrome.quiet) return null;
  const easy = chrome.mode === "easy";
  const t = chrome.t.chrome;
  const btn = easy ? "booth-chrome-btn booth-chrome-btn-easy" : "booth-chrome-btn";
  return (
    <footer
      className={`mt-[2vh] flex flex-wrap items-center gap-3 ${easy ? "justify-between" : "justify-start"}`}
      data-testid="booth-footer"
    >
      {chrome.goHome && (
        <button type="button" className={btn} onClick={chrome.goHome} data-testid="go-home">
          <span aria-hidden>←</span> {t.home}
        </button>
      )}
      <button
        type="button"
        className={btn}
        onClick={chrome.toggleMode}
        aria-pressed={easy}
        data-testid="toggle-mode"
      >
        {easy ? t.toStandard : t.toEasy}
      </button>
    </footer>
  );
}

/**
 * Modal for the booth: focus moves into it, Escape and the backdrop close it, focus returns to
 * where it was. Large type in both modes; it sits above everything, including the help corner.
 */
export function KioskDialog({
  title,
  children,
  onClose,
  actions,
  testId,
}: {
  title: string;
  children?: React.ReactNode;
  onClose: () => void;
  actions: React.ReactNode;
  testId?: string;
}) {
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    boxRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && boxRef.current) {
        // Keep keyboard focus inside the dialog.
        const items = [...boxRef.current.querySelectorAll<HTMLElement>("button, a[href]")];
        if (!items.length) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-6"
      onClick={onClose}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        className="kiosk-dialog flex max-h-[90dvh] w-full max-w-3xl flex-col gap-6 overflow-y-auto rounded-3xl bg-paper p-[max(24px,4vh)] text-left"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="booth-title">
          {title}
        </h2>
        {children}
        <div className="flex flex-wrap justify-end gap-4">{actions}</div>
      </div>
    </div>
  );
}
