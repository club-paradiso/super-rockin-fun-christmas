"use client";

import { useEffect, useState } from "react";
import {
  FULLSCREEN_BUTTON_IDLE_MS,
  enterWallFullscreen,
  fullscreenSupported,
  readFullscreenView,
  wallCoversScreen,
} from "@/lib/wall/fullscreen";

/**
 * Whether the 「전체화면」 button should be on screen: the browser can go fullscreen, the wall
 * does not cover the screen yet, and someone moved the pointer (or the page just opened) within
 * FULLSCREEN_BUTTON_IDLE_MS. Once the wall covers the screen, nothing shows until Escape.
 * Never inside another program's web view (`enabled` false, lib/wall/embed.ts).
 */
export function useFullscreenButton(enabled = true): boolean {
  // Starts false so the server render and the first client render agree.
  const [canEnter, setCanEnter] = useState(false);
  const [active, setActive] = useState(true);

  useEffect(() => {
    const check = () =>
      setCanEnter(fullscreenSupported() && !wallCoversScreen(readFullscreenView()));
    check();
    document.addEventListener("fullscreenchange", check);
    document.addEventListener("webkitfullscreenchange", check);
    window.addEventListener("resize", check);
    return () => {
      document.removeEventListener("fullscreenchange", check);
      document.removeEventListener("webkitfullscreenchange", check);
      window.removeEventListener("resize", check);
    };
  }, []);

  useEffect(() => {
    let timer = window.setTimeout(() => setActive(false), FULLSCREEN_BUTTON_IDLE_MS);
    const wake = () => {
      setActive(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setActive(false), FULLSCREEN_BUTTON_IDLE_MS);
    };
    window.addEventListener("pointermove", wake);
    window.addEventListener("pointerdown", wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("pointerdown", wake);
    };
  }, []);

  return enabled && canEnter && active;
}

export function WallFullscreenButton() {
  return (
    <button
      type="button"
      data-testid="wall-fullscreen"
      onClick={(e) => {
        e.stopPropagation();
        enterWallFullscreen();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="wall-fullscreen-btn"
    >
      <span className="wall-fullscreen-label">전체화면</span>
      <span className="wall-fullscreen-hint">끌 때는 Esc</span>
    </button>
  );
}
