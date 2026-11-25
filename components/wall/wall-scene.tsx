"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getWallTheme } from "@/config/wall-themes";
import { WALL_ROPE, ropePieces, type SceneLayout } from "@/lib/wall/layout";
import type { Rect } from "@/lib/wall/layout";
import {
  WALL_LIGHT,
  WALL_LOGO,
  WALL_LOGO_HALO_PAD,
  clipImage,
  fitTheme,
  type WallTheme,
} from "@/lib/wall/themes";

/**
 * One wall theme (D85): its bundled background picture, the twine if the picture has none, the
 * wall logo (평화의 벽, in the form the picture uses, D117) at its place in the picture (`mark`,
 * from the fit plan, D116), and the hung
 * photos on top. Drawn in scene pixels
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
  feather = null,
  mark = null,
  hiDpi = false,
}: {
  theme: WallTheme;
  /** The logo's box in scene px (`WallFitPlan.mark`); none without one. */
  mark?: Rect | null;
  /** Use the 2× picture: the screen shows the scene enlarged (and this is not low-spec mode). */
  hiDpi?: boolean;
  /** The screen's shape: the picture fading out is cut for it too (D91). */
  aspect?: number | null;
  layout: SceneLayout;
  lite: boolean;
  children: ReactNode;
  overlay?: ReactNode;
  /**
   * Fade the picture's edges on these axes into the soft fill behind it (D110): only where the
   * picture leaves a band, so the band reads as more of the same scene instead of an edge.
   */
  feather?: { x: boolean; y: boolean } | null;
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
  const picture = (t: WallTheme) => (hiDpi && t.background2x) || t.background;
  const edge = featherMask(feather);
  const rope = theme.rope
    ? ropePieces(theme.scene.line, theme.rope.x1, theme.rope.x2, theme.rope.width)
    : null;

  return (
    <div
      className={`wall-scene absolute overflow-hidden ${lite ? "wall-lite" : ""}`}
      style={{
        width: layout.width,
        height: layout.height,
        // With feathered edges the scene must not paint its own fallback: the fade has to reveal
        // the blurred picture behind it (the stage keeps the fallback underneath).
        background: feather && (feather.x || feather.y) ? "transparent" : theme.fallbackColor,
      }}
      data-testid="wall-scene"
      data-slots={layout.slots.length}
      data-theme={theme.id}
      data-scene-size={`${layout.width}x${layout.height}`}
      data-tone={theme.tone}
    >
      {underTheme && (
        // eslint-disable-next-line @next/next/no-img-element -- static, same-origin, works offline
        <img
          src={picture(underTheme)}
          alt=""
          aria-hidden
          // A picture of another shape (a 32:9 theme under a 2.4:1 one, D91) is cropped, never
          // stretched, for the two seconds it fades out.
          className="absolute inset-0 h-full w-full object-cover"
          style={edge}
        />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element -- static, same-origin, works offline */}
      <img
        key={theme.id}
        src={picture(theme)}
        alt=""
        aria-hidden
        className={`absolute inset-0 h-full w-full ${under ? "wall-background-in" : ""}`}
        style={edge}
        data-testid="wall-background"
        data-feather={feather ? `${feather.x ? "x" : ""}${feather.y ? "y" : ""}` : ""}
      />
      {rope && (
        <svg
          className="wall-rope absolute inset-0"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          aria-hidden
          data-testid="wall-rope"
        >
          <defs>
            {/* The rope's shadow on the backdrop falls with the one light (top left). */}
            <filter id="wall-rope-shadow" x="-2%" y="-50%" width="104%" height="200%">
              <feDropShadow
                dx={WALL_LIGHT.rope.x}
                dy={WALL_LIGHT.rope.y}
                stdDeviation={2.5}
                floodColor="rgb(43 26 16)"
                floodOpacity={0.38}
              />
            </filter>
          </defs>
          <g filter="url(#wall-rope-shadow)">
            {rope.tiles.map((t, i) => (
              <g key={i} transform={`translate(${t.x} ${t.y}) rotate(${t.angle})`}>
                <image
                  href={WALL_ROPE.tile.src}
                  x={t.dx}
                  y={t.dy}
                  width={t.w}
                  height={t.h}
                  preserveAspectRatio="xMinYMid slice"
                />
              </g>
            ))}
            {(["left", "right"] as const).map((side) => {
              const e = rope[side];
              return (
                <g key={side} transform={`translate(${e.x} ${e.y}) rotate(${e.angle})`}>
                  <image
                    href={WALL_ROPE[side].src}
                    x={e.dx}
                    y={e.dy}
                    width={e.w}
                    height={e.h}
                    data-testid={`wall-rope-${side}`}
                  />
                </g>
              );
            })}
          </g>
        </svg>
      )}
      {theme.wordmark && mark && (
        <div
          className="wall-logo absolute"
          role="img"
          aria-label="평화의 벽 · The Wall of Peacemakers"
          data-testid="wall-wordmark"
          data-tone={theme.wordmark.tone}
          data-form={theme.wordmark.form}
          style={{
            color: theme.wordmark.color,
            left: mark.x,
            top: mark.y,
            width: mark.width,
            height: mark.height,
            padding:
              theme.wordmark.tone === "label"
                ? `${(mark.height - theme.wordmark.size) / 2}px ${(mark.width - theme.wordmark.size * WALL_LOGO[theme.wordmark.form].aspect) / 2}px`
                : 0,
          }}
        >
          {theme.wordmark.tone === "cream" && (
            // Starlight: the form blurred, screened in behind the letters.
            <span
              className="wall-logo-halo"
              aria-hidden
              style={{
                inset: -theme.wordmark.size * WALL_LOGO_HALO_PAD,
                WebkitMaskImage: `url(${WALL_LOGO[theme.wordmark.form].halo})`,
                maskImage: `url(${WALL_LOGO[theme.wordmark.form].halo})`,
              }}
            />
          )}
          {theme.wordmark.tone === "carved" && (
            // Cut into wood: the groove's lower edge catches the light.
            <span className="wall-logo-mark wall-logo-mark--lit" aria-hidden />
          )}
          <span className="wall-logo-mark" aria-hidden />
        </div>
      )}
      {children}
      {overlay}
    </div>
  );
}

/** Share of the picture's length that fades out at an edge with a band. */
const FEATHER = "4%";

/** CSS mask that fades the picture out at the edges of the banded axes; nothing without bands. */
export function featherMask(feather: { x: boolean; y: boolean } | null | undefined) {
  if (!feather || (!feather.x && !feather.y)) return undefined;
  const ramp = (dir: string) =>
    `linear-gradient(${dir}, transparent 0, #000 ${FEATHER}, #000 calc(100% - ${FEATHER}), transparent 100%)`;
  const layers = [feather.x && ramp("to right"), feather.y && ramp("to bottom")].filter(Boolean);
  const mask = layers.join(", ");
  // Two ramps: keep only where both are opaque (corners fade on both sides).
  const composite = layers.length === 2 ? "intersect" : undefined;
  return {
    maskImage: mask,
    WebkitMaskImage: mask,
    maskComposite: composite,
    WebkitMaskComposite: composite ? "source-in" : undefined,
  } as const;
}

/**
 * What holds a photo: the theme's clip picture (a strip of masking tape folded over the line),
 * drawn in the photo's box, whose top is the line at the hang point. Placed by its own numbers
 * (`WallClip`): the line crosses it `lineY` px below its top. A clip with `tilts` is turned a little
 * differently on each slot, about where it crosses the line, and a clip with `images` gets a
 * different picture on each slot, so the tapes do not look stamped.
 * Nothing for a theme whose pegs are already in the picture.
 */
export function Clip({ theme, slot = 0 }: { theme: WallTheme; slot?: number }) {
  const { hang } = theme;
  if (hang.kind !== "clip") return null;
  const tilt = hang.tilts?.length ? hang.tilts[slot % hang.tilts.length]! : 0;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static, same-origin, works offline
    <img
      src={clipImage(hang, slot)}
      alt=""
      aria-hidden
      draggable={false}
      data-testid="wall-clip"
      className="pointer-events-none absolute left-1/2 max-w-none"
      style={{
        top: -hang.lineY,
        width: hang.width,
        height: hang.height,
        marginLeft: -hang.centerX,
        zIndex: 2,
        transform: tilt ? `rotate(${tilt}deg)` : undefined,
        transformOrigin: `${hang.centerX}px ${hang.lineY}px`,
      }}
    />
  );
}
