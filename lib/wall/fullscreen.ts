/**
 * 전체화면 (the wall's own fullscreen, for a browser opened by hand at /wall).
 *
 * The rule the user asked for: one way in (the 「전체화면」 button, a double-click or F), and one
 * way out, Escape, which the browser itself handles. Nothing on the wall leaves fullscreen, and
 * while the wall covers the screen nothing is drawn over it.
 *
 * "Covers the screen" is either the Fullscreen API (`document.fullscreenElement`) or a window as
 * large as the screen: the venue launchers open the wall with `--kiosk` and F11 does the same,
 * neither of which sets `fullscreenElement`. In both the button stays away.
 */

export interface FullscreenView {
  /** document.fullscreenElement (or the webkit one) is set. */
  apiFullscreen: boolean;
  innerWidth: number;
  innerHeight: number;
  screenWidth: number;
  screenHeight: number;
}

/** The wall already fills the whole screen; a 2 px slack absorbs rounding on scaled displays. */
export function wallCoversScreen(v: FullscreenView): boolean {
  if (v.apiFullscreen) return true;
  if (!(v.screenWidth > 0 && v.screenHeight > 0)) return false;
  return v.innerWidth >= v.screenWidth - 2 && v.innerHeight >= v.screenHeight - 2;
}

/** How long the button stays after the page opens or the pointer last moved. */
export const FULLSCREEN_BUTTON_IDLE_MS = 4_000;

type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
};
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => void };

export function fullscreenSupported(doc: Document = document): boolean {
  const d = doc as FsDocument;
  const root = doc.documentElement as FsElement;
  if (typeof root.requestFullscreen === "function") return d.fullscreenEnabled !== false;
  return typeof root.webkitRequestFullscreen === "function" && d.webkitFullscreenEnabled !== false;
}

export function readFullscreenView(win: Window = window): FullscreenView {
  const d = win.document as FsDocument;
  return {
    apiFullscreen: !!(d.fullscreenElement || d.webkitFullscreenElement),
    innerWidth: win.innerWidth,
    innerHeight: win.innerHeight,
    screenWidth: win.screen?.width ?? 0,
    screenHeight: win.screen?.height ?? 0,
  };
}

/**
 * Enter fullscreen. Never leaves it: Escape (the browser's own) is the only way out. Browsers
 * allow this only from a user gesture; a refusal changes nothing.
 */
export function enterWallFullscreen(doc: Document = document): void {
  const d = doc as FsDocument;
  if (d.fullscreenElement || d.webkitFullscreenElement) return;
  const root = doc.documentElement as FsElement;
  try {
    if (typeof root.requestFullscreen === "function")
      void root.requestFullscreen({ navigationUI: "hide" }).catch(() => undefined);
    else root.webkitRequestFullscreen?.();
  } catch {
    // Not allowed here: nothing to do.
  }
}
