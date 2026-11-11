"use client";

import { createContext, useContext, useEffect, useId, useRef } from "react";
import type { KioskMode } from "@/lib/storage/types";

/**
 * What every booth screen shares (release 2.0): the guest's screen mode, the way home,
 * and help. Provided once by KioskApp so screens do not pass it around.
 */
export interface KioskChrome {
  mode: KioskMode;
  /** Easy mode: the current step in words ("2단계 · 사진 확인"). */
  easyStep: { step: number; total: number; label: string } | null;
  toggleMode: () => void;
  /** "처음으로": asks first when a session is under way. Null where it makes no sense. */
  goHome: (() => void) | null;
  openHelp: () => void;
  /** Hide the footer (while counting down and shooting: nothing to press, nothing to distract). */
  quiet: boolean;
}

export const KioskChromeContext = createContext<KioskChrome | null>(null);
export const useKioskChrome = () => useContext(KioskChromeContext);

/**
 * Footer of every booth screen. Standard: three quiet buttons. Easy: the same three, large, high
 * contrast, with words and icons together (WCAG 2.2: target size, visible labels).
 */
export function BoothFooter() {
  const chrome = useKioskChrome();
  if (!chrome || chrome.quiet) return null;
  const easy = chrome.mode === "easy";
  const btn = easy ? "booth-chrome-btn booth-chrome-btn-easy" : "booth-chrome-btn";
  return (
    <footer
      className={`mt-[2vh] flex flex-wrap items-center gap-3 ${easy ? "justify-between" : "justify-start"}`}
      data-testid="booth-footer"
    >
      {chrome.goHome && (
        <button type="button" className={btn} onClick={chrome.goHome} data-testid="go-home">
          <span aria-hidden>←</span> 처음으로
        </button>
      )}
      <button type="button" className={btn} onClick={chrome.openHelp} data-testid="open-help">
        <span aria-hidden>?</span> {easy ? "도움이 필요해요" : "도움말"}
      </button>
      <button
        type="button"
        className={btn}
        onClick={chrome.toggleMode}
        aria-pressed={easy}
        data-testid="toggle-mode"
      >
        <span aria-hidden>{easy ? "가" : "가+"}</span> {easy ? "기본 화면으로" : "쉬운 화면"}
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

/** Guest help: plain steps for the things people get stuck on. Same text in both modes. */
export function GuestHelp({ onClose }: { onClose: () => void }) {
  return (
    <KioskDialog
      title="도움말"
      onClose={onClose}
      testId="guest-help"
      actions={
        <button type="button" className="booth-btn-primary" onClick={onClose}>
          닫기
        </button>
      }
    >
      <dl className="flex flex-col gap-5">
        <HelpItem icon="📷" title="QR은 이렇게 찍어요">
          휴대폰 기본 카메라를 켜고 QR을 화면 가운데에 비춰 주세요. 화면에 뜨는 주소를 누르면
          열려요.
        </HelpItem>
        <HelpItem icon="💾" title="사진은 이렇게 저장해요">
          열린 화면에서 &lsquo;사진 저장하기&rsquo;를 눌러요. 아이폰은 이어서 &lsquo;이미지
          저장&rsquo;을 눌러요.
        </HelpItem>
        <HelpItem icon="🎥" title="화면이 멈추거나 카메라가 안 보이면">
          &lsquo;다시 시도&rsquo;를 눌러 주세요. 그래도 안 되면 &lsquo;처음으로&rsquo;를 누르면
          돼요.
        </HelpItem>
        <HelpItem icon="🙋" title="도우미가 필요하면">
          부스 옆 안내 봉사자에게 말씀해 주세요. 미디어월에 걸린 사진을 내리는 것도 도와드려요.
        </HelpItem>
      </dl>
    </KioskDialog>
  );
}

function HelpItem({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4">
      <span className="text-[clamp(28px,4vh,44px)] leading-none" aria-hidden>
        {icon}
      </span>
      <div>
        <dt className="text-[clamp(22px,3vh,32px)] font-bold text-ink">{title}</dt>
        <dd className="booth-lead mt-1">{children}</dd>
      </div>
    </div>
  );
}
