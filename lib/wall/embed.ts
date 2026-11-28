/**
 * The wall inside another program (docs/MILLUMIN.md): a show-control program's browser media
 * (Millumin 4), a browser source, anything that renders the page off screen and puts the picture
 * on the LED itself. There the page is not a window a person opened:
 *
 *  - fullscreen belongs to the host program, so the wall offers no 「전체화면」 button and never
 *    asks for fullscreen (the button would be baked into the LED picture after every reload);
 *  - the host decides when the page draws, so a silent animation-frame clock is not a stall;
 *  - the page fills whatever size the host renders it at: that size is the screen.
 *
 * Asked for in the address only (`/wall?embed=1`): the page cannot tell such a host from a small
 * browser window, and a guess would take the button away from a person who needs it.
 * `?check=1` is the staff check: numbers over the wall (size, shape, who the feed says this screen
 * is, photos, last answer, drawing rate) so a person can see in the host program why a wall looks
 * still or the wrong shape. Never on by itself.
 */
export interface WallViewOptions {
  embed: boolean;
  check: boolean;
  /**
   * `?photos=N`: hang at least N photos on this screen (0 = let the fit decide). A person's choice
   * for one screen: more of the picture and more guests at once, each photo smaller, with bands
   * where the photos need the room (`minSlots` in lib/wall/fit.ts). Never more than the picture
   * has places for.
   */
  minPhotos: number;
}

const on = (v: string | undefined | null) => v === "1" || v === "true";

export function parseWallView(q: {
  embed?: string | null;
  check?: string | null;
  photos?: string | null;
}): WallViewOptions {
  const n = /^\d{1,2}$/.test(q.photos ?? "") ? Number(q.photos) : 0;
  return { embed: on(q.embed), check: on(q.check), minPhotos: n };
}

export interface WallShapeCheck {
  /** "3840 × 1080" */
  size: string;
  /** Width over height, two decimals. */
  ratio: string;
  /** The LED size asked for (WALL_CANVAS / ?canvas=) has another shape than this screen. */
  mismatch: boolean;
}

/** What the check says about the size the page was given. Pure. */
export function wallShapeCheck(
  viewport: { width: number; height: number },
  canvas: { width: number; height: number } | null,
): WallShapeCheck {
  const ratio = viewport.width / viewport.height;
  const want = canvas ? canvas.width / canvas.height : ratio;
  return {
    size: `${viewport.width} × ${viewport.height}`,
    ratio: ratio.toFixed(2),
    mismatch: Math.abs(ratio - want) / want > 0.01,
  };
}
