import type { Metadata } from "next";
import { cookies } from "next/headers";
import { StaffNotice } from "@/components/staff-notice";
import { WallApp } from "@/components/wall/wall-app";
import { authenticateKiosk } from "@/lib/kiosk-auth/server";
import { KIOSK_COOKIE } from "@/lib/kiosk-auth/session";
import { ConfigError, getServerConfig } from "@/lib/server/env";
import { logEvent } from "@/lib/server/log";
import { parseCanvas } from "@/lib/wall/layout";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "STUDIO SHALOM · Media Wall",
  robots: { index: false, follow: false },
};

/**
 * The media wall. The display is an enrolled device (same one-time code and revocable HttpOnly
 * session as a kiosk, see DECISIONS D36); everything it shows comes from /api/wall/feed.
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

  const auth = await authenticateKiosk((await cookies()).get(KIOSK_COOKIE)?.value ?? null);
  if (!auth.ok) {
    return (
      <StaffNotice title="이 화면은 아직 미디어월로 등록되지 않았어요" testId="wall-not-enrolled">
        <p>운영 화면에서 만든 일회용 코드로 이 기기를 등록해 주세요.</p>
        <a href="/kiosk/enroll?next=wall" className="btn-primary mt-8">
          기기 등록하기
        </a>
      </StaffNotice>
    );
  }
  const q = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const canvas = parseCanvas(one(q.canvas)) ?? parseCanvas(process.env.WALL_CANVAS);
  const lite = one(q.lite) === "1" || process.env.WALL_LITE === "1";
  return <WallApp canvas={canvas} lite={lite} />;
}
