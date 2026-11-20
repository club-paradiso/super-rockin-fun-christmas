"use client";

import { useEffect, useState } from "react";
import type { KioskLang } from "@/lib/kiosk/copy";

const LABELS = {
  ko: {
    enter: "전체화면",
    exit: "전체화면 종료",
    setup: "전체화면 설정",
    installed: "전체화면 실행 중",
    help: "iPad Safari에서는 공유 → 홈 화면에 추가를 누르고, 홈 화면의 STUDIO SHALOM 아이콘으로 실행하세요. 주소 표시줄 없이 독립 실행됩니다.",
    failed:
      "브라우저에서 전체화면 전환이 허용되지 않았어요. 브라우저 메뉴에서 전체화면을 실행하거나 홈 화면에 추가해 주세요.",
  },
  en: {
    enter: "Fullscreen",
    exit: "Exit fullscreen",
    setup: "Fullscreen setup",
    installed: "App mode active",
    help: "On iPad Safari, choose Share → Add to Home Screen, then launch STUDIO SHALOM from its home-screen icon to hide the browser bars.",
    failed:
      "The browser blocked fullscreen. Use the browser's fullscreen command or add this kiosk to your home screen.",
  },
  zh: {
    enter: "全屏显示",
    exit: "退出全屏",
    setup: "全屏设置",
    installed: "已在应用模式运行",
    help: "在 iPad Safari 中，点按共享 → 添加到主屏幕，然后通过主屏幕上的 STUDIO SHALOM 图标打开，即可隐藏浏览器工具栏。",
    failed: "浏览器未允许切换全屏。请使用浏览器的全屏功能，或将此页面添加到主屏幕。",
  },
} as const;

type AppleNavigator = Navigator & { standalone?: boolean };

function standaloneMode(): boolean {
  if ((navigator as AppleNavigator).standalone === true) return true;
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(display-mode: standalone)").matches;
}

/**
 * Browser fullscreen is gesture-gated; iPadOS 15 Safari cannot fullscreen arbitrary elements.
 * In that case show actual Add-to-Home-Screen instructions, never pretend the request succeeded.
 * Keep the control outside the scrollable sheet so the frame-selection and QR hit targets remain real.
 */
export function KioskFullscreenControl({ lang }: { lang: KioskLang }) {
  const [canToggle, setCanToggle] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [help, setHelp] = useState<"none" | "setup" | "failed">("none");
  const t = LABELS[lang];
  let buttonLabel: string;
  if (standalone) buttonLabel = t.installed;
  else if (nativeFullscreen) buttonLabel = t.exit;
  else buttonLabel = canToggle ? t.enter : t.setup;

  useEffect(() => {
    const update = () => {
      setNativeFullscreen(Boolean(document.fullscreenElement));
      setStandalone(standaloneMode());
      const root = document.querySelector<HTMLElement>(".kiosk-root");
      setCanToggle(Boolean(document.fullscreenEnabled && root?.requestFullscreen));
    };
    update();
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  const toggle = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation(); // The attract screen otherwise treats a click as "start".
    if (standalone) return;
    if (!canToggle) {
      setHelp((previous) => (previous === "setup" ? "none" : "setup"));
      return;
    }
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        const root = document.querySelector<HTMLElement>(".kiosk-root");
        if (!root) return;
        await root.requestFullscreen();
      }
      setHelp("none");
    } catch {
      setHelp("failed");
    }
  };

  return (
    <div className="kiosk-fullscreen-control">
      <button
        type="button"
        className="kiosk-fullscreen-button"
        data-testid="fullscreen-toggle"
        aria-expanded={help !== "none"}
        aria-controls={help !== "none" ? "kiosk-fullscreen-help" : undefined}
        disabled={standalone}
        onClick={toggle}
      >
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          {nativeFullscreen ? (
            <path d="M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6" />
          ) : (
            <path d="M3 9V3h6m6 0h6v6M3 15v6h6m12-6v6h-6" />
          )}
        </svg>
        <span>{buttonLabel}</span>
      </button>
      {help !== "none" && (
        <div
          id="kiosk-fullscreen-help"
          role="status"
          data-testid="fullscreen-help"
          className="kiosk-fullscreen-help"
        >
          {help === "failed" ? t.failed : t.help}
        </div>
      )}
    </div>
  );
}
