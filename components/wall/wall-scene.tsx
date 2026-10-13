"use client";

import type { CSSProperties, ReactNode } from "react";
import type { Rect, SceneLayout } from "@/lib/wall/layout";

/**
 * "밤 11시 한림의 방" (docs/ARCHITECTURE.md 1.8): a dark room, a wide-open window full of stars,
 * a clothesline with fairy lights strung across it. Drawn in canvas pixels; the parent scales it
 * to the screen. Everything is local (no fonts or images from the internet). Only opacity and
 * transform are animated, and low-spec mode turns the twinkling off.
 */
const rect = (r: Rect): CSSProperties => ({
  left: r.x,
  top: r.y,
  width: r.width,
  height: r.height,
});

/** Same stars on every load (no Math.random: the scene must not shuffle on each reload). */
function stars(layout: SceneLayout, count: number) {
  let seed = 2026;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const { window: w } = layout;
  return Array.from({ length: count }, (_, i) => ({
    key: i,
    x: w.x + rand() * w.width,
    // Mostly in the upper sky, above and around the line.
    y: w.y + rand() ** 1.6 * w.height * 0.8,
    r: 0.6 + rand() * 1.8,
    delay: rand() * 4,
  }));
}

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
  const { width: W, height: H, window: win, line } = layout;
  const unit = H / 1000; // scene-relative size unit
  const frame = Math.max(4, Math.round(unit * 14));
  const midX = (line.x0 + line.x1) / 2;
  const path = `M ${line.x0} ${line.y0} Q ${midX} ${line.y0 + 2 * line.sag} ${line.x1} ${line.y0}`;

  return (
    <div
      className={`absolute overflow-hidden ${lite ? "wall-lite" : ""}`}
      style={{ width: W, height: H }}
      data-testid="wall-scene"
      data-slots={layout.slots.length}
    >
      {/* The room: a warm dark wall around the window, lamp light from below. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 50% 115%, rgba(255,190,120,0.18), transparent 55%), #17110d",
        }}
      />
      {/* The open window and the night sky. */}
      <div
        className="absolute"
        style={{
          ...rect(win),
          background: "radial-gradient(ellipse at 70% 20%, #1d2a4d 0%, #0d1428 55%, #070b17 100%)",
        }}
      />
      <svg className="absolute inset-0" width={W} height={H} aria-hidden>
        {stars(layout, lite ? 70 : 160).map((s) => (
          <circle
            key={s.key}
            cx={s.x}
            cy={s.y}
            r={s.r * unit * 1.6}
            fill="#f7efe0"
            className="wall-star"
            style={{ animationDelay: `${s.delay}s` }}
          />
        ))}
      </svg>
      {/* Window frame and the open casements folded against the wall. */}
      <div
        className="absolute"
        style={{ ...rect(win), boxShadow: `inset 0 0 0 ${frame}px #5a3d27` }}
      />
      <div
        className="absolute"
        style={{
          left: win.x,
          top: win.y,
          width: Math.max(frame * 2, win.width * 0.018),
          height: win.height,
          background: "linear-gradient(90deg, #3d2a1c, #5a3d27)",
        }}
      />
      <div
        className="absolute"
        style={{
          left: win.x + win.width - Math.max(frame * 2, win.width * 0.018),
          top: win.y,
          width: Math.max(frame * 2, win.width * 0.018),
          height: win.height,
          background: "linear-gradient(270deg, #3d2a1c, #5a3d27)",
        }}
      />

      {/* The clothesline and its fairy lights. */}
      <svg className="absolute inset-0" width={W} height={H} aria-hidden>
        <path
          d={path}
          fill="none"
          stroke="#cdb48c"
          strokeWidth={Math.max(1.5, unit * 3.2)}
          data-testid="wall-line"
        />
        {layout.lights.map((l, i) => (
          <g key={i}>
            <circle cx={l.x} cy={l.y} r={unit * 14} fill="rgba(255,196,110,0.18)" />
            <circle
              cx={l.x}
              cy={l.y + unit * 4}
              r={unit * 4.5}
              fill="#ffd28a"
              className="wall-light"
              style={{ animationDelay: `${(i % 7) * 0.45}s` }}
            />
          </g>
        ))}
      </svg>

      {children}

      <p
        className="absolute text-center font-bold text-amber"
        style={{
          left: win.x,
          width: win.width,
          top: win.y + win.height - unit * 70,
          fontSize: unit * 34,
          letterSpacing: "0.32em",
        }}
      >
        FOLLOW THE LIGHTS
      </p>
      {overlay}
    </div>
  );
}

/** A wooden clothes peg, drawn at the clip point (top centre of a hanging photo). */
export function Peg({ unit }: { unit: number }) {
  return (
    <div
      aria-hidden
      className="absolute left-1/2 rounded-[3px]"
      style={{
        top: -unit * 22,
        width: unit * 16,
        height: unit * 52,
        marginLeft: -unit * 8,
        background: "linear-gradient(90deg, #b88a5a, #e2bd8b 45%, #a97b4d)",
        boxShadow: "0 2px 6px rgba(0,0,0,0.45)",
        zIndex: 2,
      }}
    />
  );
}
