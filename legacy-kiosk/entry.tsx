import { createRoot } from "react-dom/client";
import "@fontsource-variable/noto-sans-kr";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource/cormorant-garamond/latin-500.css";
import "@fontsource/cormorant-garamond/latin-600.css";
import "@fontsource/nanum-myeongjo/400.css";
import "@/app/globals.css";
import "@/app/kiosk-figma.css";
import "./fallback.css";
import { KioskApp } from "@/components/kiosk/kiosk-app";

const container = document.getElementById("legacy-kiosk");
if (container?.dataset.config) {
  const props = JSON.parse(container.dataset.config) as React.ComponentProps<typeof KioskApp>;
  delete container.dataset.config;
  createRoot(container).render(<KioskApp {...props} frontend="legacy" />);
}
