"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getWallTheme } from "@/config/wall-themes";
import { ropePath, type SceneLayout } from "@/lib/wall/layout";
import { fitTheme, type WallTheme } from "@/lib/wall/themes";

/**
 * One wall theme (D85): its bundled background picture, the twine if the picture has none, the
 * STUDIO SHALOM wordmark where no photo reaches, and the hung photos on top. Drawn in scene pixels
 * (3840 × 1080, or the size of the theme's cut for this screen shape, D91); the parent scales it
 * to the screen. Nothing comes from the internet.
 *
 * When the theme changes the new picture fades in over the old one (no fade in low-spec mode or
 * with reduced motion); the old picture is dropped once the new one covers it.
 */
export function WallScene({
  theme,
  aspect = null,
  layout,
  lite,
  children,
  overlay,
}: {
  theme: WallTheme;
  /** The screen's shape: the picture fading out is cut for it too (D91). */
  aspect?: number | null;
  layout: SceneLayout;
  lite: boolean;
  children: ReactNode;
  overlay?: ReactNode;
}) {
  // The picture under the current one during a change, by theme id.
  const [shown, setShown] = useState(theme.id);
  const [under, setUnder] = useState<string | null>(null);
  if (shown !== theme.id) {
    setUnder(shown);
    setShown(theme.id);
  }
  useEffect(() => {
    if (!under) return;
    const id = setTimeout(() => setUnder(null), 2_000);
    return () => clearTimeout(id);
  }, [under]);
  const underTheme = under ? fitTheme(getWallTheme(under), aspect) : null;

  return (
    <div
      className={`wall-scene absolute overflow-hidden ${lite ? "wall-lite" : ""}`}
      style={{ width: layout.width, height: layout.height, background: theme.fallbackColor }}
      data-testid="wall-scene"
      data-slots={layout.slots.length}
      data-theme={theme.id}
      data-scene-size={`${layout.width}x${layout.height}`}
      data-tone={theme.tone}
    >
      {underTheme && (
        // eslint-disable-next-line @next/next/no-img-element -- static, same-origin, works offline
        <img
          src={underTheme.background}
          alt=""
          aria-hidden
          // A picture of another shape (a 32:9 theme under a 2.4:1 one, D91) is cropped, never
          // stretched, for the two seconds it fades out.
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element -- static, same-origin, works offline */}
      <img
        key={theme.id}
        src={theme.background}
        alt=""
        aria-hidden
        className={`absolute inset-0 h-full w-full ${under ? "wall-background-in" : ""}`}
        data-testid="wall-background"
      />
      {theme.rope && (
        <svg
          className="absolute inset-0"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          aria-hidden
          data-testid="wall-rope"
        >
          <path
            d={ropePath(theme.scene.line, theme.rope.x1, theme.rope.x2)}
            fill="none"
            stroke="rgba(43,26,16,0.28)"
            strokeWidth={theme.rope.width}
            strokeLinecap="round"
            transform="translate(0 5)"
          />
          <path
            d={ropePath(theme.scene.line, theme.rope.x1, theme.rope.x2)}
            fill="none"
            stroke={theme.rope.color}
            strokeWidth={theme.rope.width}
            strokeLinecap="round"
          />
        </svg>
      )}
      {theme.wordmark && (
        <p
          className="wall-wordmark absolute"
          data-testid="wall-wordmark"
          data-tone={theme.wordmark.tone}
          style={{
            left: theme.wordmark.x,
            top: theme.wordmark.y,
            fontSize: theme.wordmark.size,
          }}
        >
          <span className="wall-wordmark-name">Studio Shalom</span>
          <span className="wall-wordmark-rule" aria-hidden />
          <span className="wall-wordmark-sub">평화의 벽</span>
        </p>
      )}
      {children}
      {overlay}
    </div>
  );
}

/**
 * What holds a photo: the theme's clip picture, drawn in the photo's box, whose top is the line at
 * the hang point. Placed by its own numbers (`WallClip`): the line crosses it `lineY` px below its
 * top. Nothing for a theme whose pegs are already in the picture.
 */
export function Clip({ theme }: { theme: WallTheme }) {
  const { hang } = theme;
  if (hang.kind !== "clip") return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static, same-origin, works offline
    <img
      src={hang.image}
      alt=""
      aria-hidden
      draggable={false}
      className="pointer-events-none absolute left-1/2 max-w-none"
      style={{
        top: -hang.lineY,
        width: hang.width,
        height: hang.height,
        marginLeft: -hang.centerX,
        zIndex: 2,
      }}
    />
  );
}
