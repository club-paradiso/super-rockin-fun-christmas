"use client";

import { useEffect, useState } from "react";
import type { KioskLang } from "@/lib/kiosk/copy";

const LABELS = {
  ko: {
    enter: "전체화면",
    setup: "전체화면 설정",
    help: "iPad Safari에서는 공유 → 홈 화면에 추가를 누르고, 홈 화면의 STUDIO SHALOM 아이콘으로 실행하세요. 주소 표시줄 없이 독립 실행됩니다.",
    failed:
      "브라우저에서 전체화면 전환이 허용되지 않았어요. 브라우저 메뉴에서 전체화면을 실행하거나 홈 화면에 추가해 주세요.",
  },
  en: {
    enter: "Fullscreen",
    setup: "Fullscreen setup",
    help: "On iPad Safari, choose Share → Add to Home Screen, then launch STUDIO SHALOM from its home-screen icon to hide the browser bars.",
    failed:
      "The browser blocked fullscreen. Use the browser's fullscreen command or add this kiosk to your home screen.",
  },
  zh: {
    enter: "全屏显示",
    setup: "全屏设置",
    help: "在 iPad Safari 中，点按共享 → 添加到主屏幕，然后通过主屏幕上的 STUDIO SHALOM 图标打开，即可隐藏浏览器工具栏。",
    failed: "浏览器未允许切换全屏。请使用浏览器的全屏功能，或将此页面添加到主屏幕。",
  },
} as const;

type AppleNavigator = Navigator & { standalone?: boolean };

/** Launched from the home screen / an installed app: there is no browser chrome to hide. */
function appMode(): boolean {
  if ((navigator as AppleNavigator).standalone === true) return true;
  if (typeof window.matchMedia !== "function") return false;
  return (
    window.matchMedia("(display-mode: fullscreen)").matches ||
    window.matchMedia("(display-mode: standalone)").matches
  );
}

export interface KioskDisplay {
  /** Element fullscreen is on (document.fullscreenElement). */
  fullscreen: boolean;
  /** Home-screen / installed-app launch (manifest display mode). */
  app: boolean;
  /** The browser allows element fullscreen here. */
  canToggle: boolean;
}

/** What the booth is shown in right now; follows fullscreenchange and display-mode changes. */
export function useKioskDisplay(): KioskDisplay {
  const [display, setDisplay] = useState<KioskDisplay>({
    fullscreen: false,
    app: false,
    canToggle: false,
  });
  useEffect(() => {
    const update = () => {
      const root = document.querySelector<HTMLElement>(".kiosk-root");
      setDisplay({
        fullscreen: Boolean(document.fullscreenElement),
        app: appMode(),
        canToggle: Boolean(document.fullscreenEnabled && root?.requestFullscreen),
      });
    };
    update();
    document.addEventListener("fullscreenchange", update);
    const queries =
      typeof window.matchMedia === "function"
        ? ["(display-mode: fullscreen)", "(display-mode: standalone)"].map((q) =>
            window.matchMedia(q),
          )
        : [];
    queries.forEach((q) => q.addEventListener?.("change", update));
    return () => {
      document.removeEventListener("fullscreenchange", update);
      queries.forEach((q) => q.removeEventListener?.("change", update));
    };
  }, []);
  return display;
}

/** Enter or leave element fullscreen. Throws when the browser refuses. */
export async function toggleKioskFullscreen(): Promise<void> {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  const root = document.querySelector<HTMLElement>(".kiosk-root");
  if (!root) return;
  // navigationUI "hide": Chromium on Android keeps its navigation bar away too.
  await root.requestFullscreen({ navigationUI: "hide" });
}

/**
 * Setup control, not a guest control. Browser fullscreen is gesture-gated, and the browser
 * always shows its own "exit fullscreen" hint at the top when a page enters it: no page can
 * hide that. So the booth (1) stays out of sight once it is immersive: in fullscreen or
 * launched from the home screen this renders nothing on any guest screen, and leaving or
 * re-entering lives in the staff help menu (HelpFullscreen); (2) prefers app mode, where no
 * hint is ever shown (kiosk.webmanifest asks for `fullscreen`, iPad gets `standalone`).
 * iPadOS 15 Safari cannot fullscreen an element: the control then shows real
 * Add-to-Home-Screen steps and never pretends the request succeeded.
 * Keep the control outside the scrollable sheet so the frame-selection and QR hit targets remain real.
 */
export function KioskFullscreenControl({ lang }: { lang: KioskLang }) {
  const { fullscreen, app, canToggle } = useKioskDisplay();
  const [help, setHelp] = useState<"none" | "setup" | "failed">("none");
  const t = LABELS[lang];

  if (fullscreen || app) return null;

  const toggle = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation(); // The attract screen otherwise treats a click as "start".
    if (!canToggle) {
      setHelp((previous) => (previous === "setup" ? "none" : "setup"));
      return;
    }
    try {
      await toggleKioskFullscreen();
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
          <path d="M3 9V3h6m6 0h6v6M3 15v6h6m12-6v6h-6" />
        </svg>
        <span>{canToggle ? t.enter : t.setup}</span>
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

/** Staff help menu section: the only place to leave (or re-enter) fullscreen once it is on. */
export function HelpFullscreen() {
  const { fullscreen, app, canToggle } = useKioskDisplay();
  const [failed, setFailed] = useState(false);
  let status: string;
  if (app) status = "홈 화면 앱으로 실행 중이에요. 주소창도 전체화면 안내도 없어요.";
  else if (fullscreen) status = "전체화면이에요. 손님 화면에는 전체화면 버튼이 보이지 않아요.";
  else if (canToggle) status = "브라우저 화면이에요.";
  else status = "이 브라우저는 전체화면을 지원하지 않아요. 홈 화면에 추가해 실행하세요.";
  return (
    <section className="flex flex-col gap-2" data-testid="help-fullscreen">
      <h3 className="text-2xl font-bold">화면</h3>
      <p className="text-lg text-ink/75">{status}</p>
      {!app && canToggle && (
        <button
          type="button"
          className="btn-secondary"
          data-testid="help-fullscreen-toggle"
          onClick={() => {
            setFailed(false);
            toggleKioskFullscreen().catch(() => setFailed(true));
          }}
        >
          {fullscreen ? "전체화면 끝내기" : "전체화면 켜기"}
        </button>
      )}
      {failed && <p className="text-lg text-danger">브라우저가 전체화면을 허용하지 않았어요.</p>}
    </section>
  );
}
