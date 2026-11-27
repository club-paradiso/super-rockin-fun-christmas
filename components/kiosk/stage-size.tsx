"use client";

import { useCallback, useRef, type ReactNode } from "react";

/**
 * Safari 15 (the iPad mini 4) has no container queries, so a picture cannot size itself from the
 * room its stage leaves (`100cqw` / `100cqh`). There the stage is measured instead: its inner
 * width and height become `--stage-w` / `--stage-h` on the stage, and `data-measured` tells the
 * stylesheet to use them (the `@supports not (container-type: size)` block of app/globals.css).
 * A stage's size never depends on what is inside it (flex: 1 1 0 with its own min-height), so
 * measuring it cannot loop. Where container queries exist this does nothing at all.
 */
export function stageNeedsMeasuring(): boolean {
  if (typeof window === "undefined" || typeof ResizeObserver === "undefined") return false;
  try {
    return !CSS.supports("container-type: size");
  } catch {
    return false;
  }
}

export function useStageSize<T extends HTMLElement>(): (el: T | null) => void {
  const observer = useRef<ResizeObserver | null>(null);
  return useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el || !stageNeedsMeasuring()) return;
    const write = (width: number, height: number) => {
      el.style.setProperty("--stage-w", `${Math.floor(width)}px`);
      el.style.setProperty("--stage-h", `${Math.floor(height)}px`);
      el.dataset.measured = "true";
    };
    const box = el.getBoundingClientRect();
    write(box.width, box.height);
    observer.current = new ResizeObserver((entries) => {
      for (const entry of entries) write(entry.contentRect.width, entry.contentRect.height);
    });
    observer.current.observe(el);
  }, []);
}

/** A stage (`.shoot-stage`, `.fit-stage`) that is measured where the browser cannot (above). */
export function Stage({ className, children }: { className: string; children: ReactNode }) {
  const ref = useStageSize<HTMLDivElement>();
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
