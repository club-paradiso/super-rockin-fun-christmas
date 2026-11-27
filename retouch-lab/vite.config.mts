import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The skin-retouch lab page (/retouch-lab): a standalone bundle like the legacy kiosk, compiled
 * for Safari 15 so it opens on the iPad mini 4 itself (Next 16 needs Safari 16.4).
 */
export default defineConfig({
  root: fromRoot("../"),
  base: "/retouch-lab-assets/",
  publicDir: false,
  envPrefix: [],
  resolve: { alias: { "@": fromRoot("../") } },
  define: {
    "process.env.NEXT_PUBLIC_KIOSK_COUNTDOWN_SECONDS": JSON.stringify(""),
    "process.env.NEXT_PUBLIC_KIOSK_REST_SECONDS": JSON.stringify(""),
    "process.env.NEXT_PUBLIC_KIOSK_IDLE_RESET_SECONDS": JSON.stringify("90"),
  },
  oxc: { jsx: { runtime: "automatic" } },
  build: {
    target: ["safari15", "ios15"],
    cssTarget: ["safari15.6", "ios15.6"],
    outDir: fromRoot("../public/retouch-lab-assets"),
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
