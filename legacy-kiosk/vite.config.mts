import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: fromRoot("../"),
  base: "/kiosk-legacy-assets/",
  publicDir: false,
  envPrefix: [],
  resolve: { alias: { "@": fromRoot("../") } },
  define: {
    "process.env.NEXT_PUBLIC_KIOSK_COUNTDOWN_SECONDS": JSON.stringify(
      process.env.NEXT_PUBLIC_KIOSK_COUNTDOWN_SECONDS ?? "",
    ),
    "process.env.NEXT_PUBLIC_KIOSK_IDLE_RESET_SECONDS": JSON.stringify(
      process.env.NEXT_PUBLIC_KIOSK_IDLE_RESET_SECONDS ?? "90",
    ),
    "process.env.NEXT_PUBLIC_LOOKS": JSON.stringify(process.env.NEXT_PUBLIC_LOOKS ?? ""),
  },
  oxc: { jsx: { runtime: "automatic" } },
  build: {
    target: ["safari15", "ios15"],
    cssTarget: ["safari15.6", "ios15.6"],
    outDir: fromRoot("../public/kiosk-legacy-assets"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    // Use one stable entry per asset type. Next serves these with revalidation on every visit.
    cssCodeSplit: false,
    rolldownOptions: {
      input: fromRoot("./entry.tsx"),
      onwarn(warning, handler) {
        // Next marks shared components as clients. This whole build is already client-only.
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
