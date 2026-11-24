// The handwriting of the film / polaroid frames (config/hand-fonts.ts) and the polaroid date stamp
// (VT323): bundled, so they draw offline. Only the latin subset is used. Imported by every page
// that composes a v2 frame (the booth and the phone page, D113): loadFrameFonts only waits for
// faces that are already declared, so a page without these would save with fallback fonts.
import "@fontsource/caveat/latin-700.css";
import "@fontsource/nothing-you-could-do/latin-400.css";
import "@fontsource/reenie-beanie/latin-400.css";
import "@fontsource/permanent-marker/latin-400.css";
import "@fontsource/gloria-hallelujah/latin-400.css";
import "@fontsource/square-peg/latin-400.css";
import "@fontsource/rock-salt/latin-400.css";
import "@fontsource/shadows-into-light/latin-400.css";
import "@fontsource/covered-by-your-grace/latin-400.css";
import "@fontsource/give-you-glory/latin-400.css";
import "@fontsource/vt323/latin-400.css";
