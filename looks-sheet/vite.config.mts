import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The look comparison sheet (/looks) as one stand-alone bundle for Safari 15: it has to open on
 * the booth's own iPad mini 4, where Next's browser runtime does not run. Same idea as
 * legacy-kiosk/vite.config.mts. app/looks/route.ts serves the page that loads it.
 */
/**
 * LOOKS_SHEET_LITE=1 LOOKS_SHEET_OUT=<dir>: the same page as a folder of files with relative
 * addresses and few fonts, for hosting outside this app. The app's own build never sets these.
 */
const lite = process.env.LOOKS_SHEET_LITE === "1";

export default defineConfig({
  root: fromRoot("../"),
  base: lite ? "./" : "/looks-sheet-assets/",
  publicDir: false,
  envPrefix: [],
  resolve: {
    alias: [
      ...(lite
        ? [{ find: "@/looks-sheet/ui-fonts", replacement: fromRoot("./ui-fonts-lite.ts") }]
        : []),
      { find: "@", replacement: fromRoot("../") },
    ],
  },
  define: {
    "process.env.NEXT_PUBLIC_LOOKS": JSON.stringify(""),
  },
  oxc: { jsx: { runtime: "automatic" } },
  build: {
    target: ["safari15", "ios15"],
    cssTarget: ["safari15.6", "ios15.6"],
    outDir:
      lite && process.env.LOOKS_SHEET_OUT
        ? process.env.LOOKS_SHEET_OUT
        : fromRoot("../public/looks-sheet-assets"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    rolldownOptions: {
      input: fromRoot("./entry.tsx"),
      onwarn(warning, handler) {
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") handler(warning);
      },
      output: {
        entryFileNames: "entry.js",
        assetFileNames: ({ names }) =>
          names.includes("style.css") ? "entry.css" : "[name]-[hash][extname]",
      },
    },
  },
});
