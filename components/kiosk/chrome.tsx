"use client";

import { createContext, useContext, useEffect, useId, useRef } from "react";
import { KIOSK_COPY, type KioskCopy, type KioskLang } from "@/lib/kiosk/copy";
import { KioskFullscreenControl } from "./fullscreen";

/**
 * What every booth screen shares (release 2.0): the guest's language and the way home.
 * Provided once by KioskApp so screens do not pass it around.
 */
export interface KioskChrome {
  /** The guest's language (D78) and its strings. */
  lang: KioskLang;
  t: KioskCopy;
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
 * Footer of every booth screen: the way home and the step back (none where they make no sense).
 * "이전" sits beside "처음으로" at the bottom, where the hand already is (a user decision,
 * 2026-11-25): never in the header. On the v2 frame screens (`action`) it is the fixed bottom bar
 * of Figma 898:1677: "처음으로", "이전" and the screen's main button, nothing else (the
 * fullscreen switch stays on the cover, the welcome screen and every other footer).
 */
export function BoothFooter({ action }: { action?: React.ReactNode } = {}) {
  const chrome = useKioskChrome();
  if (!chrome || chrome.quiet || (!chrome.goHome && !chrome.goBack && !action)) return null;
  return (
    <footer
      className={`booth-footer ${action ? "booth-footer-bar" : ""}`}
      data-testid="booth-footer"
    >
      {chrome.goHome && (
        <button
          type="button"
          className="booth-chrome-btn"
          onClick={chrome.goHome}
          data-testid="go-home"
        >
          <span aria-hidden>←</span> {chrome.t.chrome.home}
        </button>
      )}
      {/* One step back, where nothing the guest made is lost (D78, canGoBack). */}
      {chrome.goBack && (
        <button
          type="button"
          className="booth-chrome-btn booth-back-btn"
          onClick={chrome.goBack}
          data-testid="go-back"
        >
          <span aria-hidden>‹</span> {chrome.t.chrome.back}
        </button>
      )}
      {action ?? <KioskFullscreenControl lang={chrome.lang} />}
    </footer>
  );
}

/**
 * Modal for the booth: focus moves into it, Escape and the backdrop close it, focus returns to
 * where it was. It sits above everything, including the help corner.
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
    <div className="kiosk-overlay" onClick={onClose}>
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        className="kiosk-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="booth-title">
          {title}
        </h2>
        {children}
        <div className="kiosk-dialog-actions">{actions}</div>
      </div>
    </div>
  );
}
