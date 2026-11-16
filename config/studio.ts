/**
 * The studio props (real photographs in public/studio/). Each is optional: the booth draws a CSS
 * stand-in when a picture is missing, so a deployment without them still looks finished.
 *
 *   desk      wooden desk under the frame samples (frame pick)
 *   shutter   the brass-and-leather release button (start, shoot)
 *   envelope  the kraft envelope the QR ticket comes out of (delivery)
 *   stamp     the ink ring of the "오늘 N번째 기록" stamp, recoloured to the accent token
 *
 * The lockup is the frames' outlined SVG, so the PNG ticket needs no web font for the brand.
 */
export const STUDIO_ASSETS = {
  desk: "/studio/desk-bg.jpg",
  shutter: "/studio/shutter-button.png",
  envelope: "/studio/kraft-envelope.png",
  stamp: "/studio/stamp-mark.png",
  lockup: "/frames/shalom-lockup.svg",
} as const;
