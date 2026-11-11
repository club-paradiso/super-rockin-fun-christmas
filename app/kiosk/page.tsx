import type { Metadata } from "next";
import { cookies } from "next/headers";
import { KioskApp } from "@/components/kiosk/kiosk-app";
import { StaffNotice } from "@/components/staff-notice";
import { resolveCameraMode } from "@/lib/camera";
import { authenticateKiosk } from "@/lib/kiosk-auth/server";
import { KIOSK_COOKIE } from "@/lib/kiosk-auth/session";
import { ConfigError, getServerConfig } from "@/lib/server/env";
import { logEvent } from "@/lib/server/log";
import { getBackend } from "@/lib/storage/server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "STUDIO SHALOM · Photo Booth",
  robots: { index: false, follow: false },
};

export default async function KioskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Fail loudly and visibly on a misconfigured deployment instead of printing unusable QR codes.
  try {
    getServerConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    logEvent("config_invalid", { route: "kiosk", problems: err.problems.join(" | ") }, "error");
    return (
      <StaffNotice title="서버 설정 오류" testId="kiosk-config-error">
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
      <StaffNotice title="이 기기는 아직 키오스크로 등록되지 않았어요" testId="kiosk-not-enrolled">
        <p>운영자가 등록해야 촬영을 시작할 수 있어요.</p>
        <a href="/kiosk/enroll" className="btn-primary mt-8">
          기기 등록하기
        </a>
      </StaffNotice>
    );
  }

  const { camera } = await searchParams;
  const cameraMode = resolveCameraMode(
    typeof camera === "string" ? camera : undefined,
    process.env.NEXT_PUBLIC_CAMERA_MODE,
  );
  const settings = await getBackend().settings.get();
  return (
    <KioskApp
      cameraMode={cameraMode}
      initialWallSubmissions={settings.pauseSubmissions ? "paused" : "open"}
      initialMode={settings.kioskDefaultMode}
      staffHelp={getServerConfig().staffAuth?.mode === "pin"}
    />
  );
}
