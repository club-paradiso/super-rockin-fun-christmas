import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "FOLLOW THE LIGHTS · Media Wall",
  robots: { index: false, follow: false },
};

/**
 * Placeholder for the media wall (Phase 4). Shows the EMPTY state so the display can be
 * positioned and tested at the venue. See docs/ROADMAP.md.
 */
export default function WallPage() {
  return (
    <main
      data-testid="wall"
      data-wall-state="EMPTY"
      className="night-sky flex h-dvh w-full flex-col items-center justify-end overflow-hidden pb-[12vh]"
    >
      <div className="flex gap-[3vw]" aria-hidden>
        {Array.from({ length: 7 }, (_, i) => (
          <div
            key={i}
            className="rounded-t-md bg-dusk"
            style={{ width: "6vw", height: `${10 + ((i * 37) % 9)}vh` }}
          >
            <div className="mx-auto mt-[2vh] h-[3vh] w-[2.5vw] rounded-sm bg-amber/70 shadow-[0_0_30px_rgba(255,207,138,0.6)]" />
          </div>
        ))}
      </div>
      <p className="mt-[6vh] text-[2.2vw] tracking-[0.3em] text-amber">FOLLOW THE LIGHTS</p>
      <p className="mt-2 text-[1.3vw] text-mist">곧 이 마을에 여러분의 빛이 켜집니다</p>
    </main>
  );
}
