import type { Metadata } from "next";
import { StaffNotice } from "@/components/staff-notice";
import { WallApp } from "@/components/wall/wall-app";
import { DEFAULT_WALL_THEME } from "@/config/wall-themes";
import { ConfigError, getServerConfig } from "@/lib/server/env";
import { currentWallTheme } from "@/lib/wall/server";
import { logEvent } from "@/lib/server/log";
import { parseCanvas } from "@/lib/wall/layout";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "STUDIO SHALOM · Media Wall",
  robots: { index: false, follow: false },
};

/**
 * The media wall. It opens for anyone, with no enrollment, code or password (D86): the page is
 * only the scene, and everything it shows comes from /api/wall/feed, which decides per request
 * what this viewer may be sent. A screen that IS enrolled (/kiosk/enroll?next=wall, D36) is a
 * venue display: it gets every approved photo and reports what it shows.
 *
 * Scene size: WALL_CANVAS=3840x1080 on the hub (the LED's input resolution), or ?canvas=WxH to try
 * a size at the LED; without either the scene fills the screen. Low-spec mode: WALL_LITE=1 or
 * ?lite=1.
 */
export default async function WallPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    getServerConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    logEvent("config_invalid", { route: "wall", problems: err.problems.join(" | ") }, "error");
    return (
      <StaffNotice title="서버 설정 오류" testId="wall-config-error">
        <ul className="list-disc text-left text-lg">
          {err.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </StaffNotice>
    );
  }

  const q = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const canvas = parseCanvas(one(q.canvas)) ?? parseCanvas(process.env.WALL_CANVAS);
  const lite = one(q.lite) === "1" || process.env.WALL_LITE === "1";
  // The first paint already has the right background; the feed keeps it current afterwards.
  let theme = DEFAULT_WALL_THEME;
  try {
    theme = await currentWallTheme();
  } catch (err) {
    logEvent("wall_theme_read_failed", { message: (err as Error).message }, "warn");
  }
  return <WallApp canvas={canvas} lite={lite} initialTheme={theme} />;
}
