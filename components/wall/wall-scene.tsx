"use client";

import type { ReactNode } from "react";
import { WALL_CONFIG } from "@/config/wall";
import type { SceneLayout } from "@/lib/wall/layout";

/**
 * The Figma wall (03 Media Wall, composite v3): one bundled picture of the window on Jeju at
 * 11 p.m. with the clothesline and the wordmark already in it, and the hung strips on top. Drawn in
 * scene pixels (3840 × 1080); the parent scales it to the screen. Nothing comes from the internet.
 */
export function WallScene({
  layout,
  lite,
  children,
  overlay,
}: {
  layout: SceneLayout;
  lite: boolean;
  children: ReactNode;
  overlay?: ReactNode;
}) {
  return (
    <div
      className={`absolute overflow-hidden ${lite ? "wall-lite" : ""}`}
      style={{ width: layout.width, height: layout.height }}
      data-testid="wall-scene"
      data-slots={layout.slots.length}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static, same-origin, works offline */}
      <img
        src={WALL_CONFIG.scene.background}
        alt=""
        aria-hidden
        className="absolute inset-0 h-full w-full"
        data-testid="wall-background"
      />
      {children}
      {overlay}
    </div>
  );
}

/** The brass clip (Figma Wall/Clip — brass), drawn at the clip point (top centre of a strip). */
export function Clip({ dropToStrip }: { dropToStrip: number }) {
  // The SVG is 37 × 70: a 22.4 × 56 clip at (7, 2.8) plus room for its shadow. Its top sits 6 px
  // above the line (Figma), i.e. 26 px above the strip.
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static, same-origin, works offline
    <img
      src={WALL_CONFIG.scene.clip}
      alt=""
      aria-hidden
      className="absolute left-1/2"
      style={{
        top: -dropToStrip - 6 - 2.8,
        width: 37,
        height: 70,
        marginLeft: -11.2 - 7,
        zIndex: 2,
      }}
    />
  );
}
