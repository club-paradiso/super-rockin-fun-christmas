import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "public/kiosk-legacy-assets/**",
      "public/retouch-lab-assets/**",
      "public/camera-lab-assets/**",
      "public/retouch/mediapipe/**",
      "public/looks-sheet-assets/**",
      "next-env.d.ts",
      // Agent worktrees are whole copies of the repository (with their own builds).
      ".claude/**",
    ],
  },
];

export default config;
