import type { Metadata, Viewport } from "next";
import { RemoteCameraPage } from "@/components/camera/remote-camera-page";
import { remoteCameraDisabled } from "@/lib/remote-camera/server";
import { StaffNotice } from "@/components/staff-notice";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "원격 카메라 · STUDIO SHALOM",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
};

/**
 * The iPhone's page (staff only in practice). Public HTML, but nothing happens without a pairing
 * code from /admin: the page itself holds no secret and shows nothing about any booth.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (remoteCameraDisabled())
    return (
      <StaffNotice title="원격 카메라가 꺼져 있어요" testId="camera-disabled">
        <p>운영 서버에서 이 기능을 끈 상태예요.</p>
      </StaffNotice>
    );
  const { code } = await searchParams;
  return <RemoteCameraPage initialCode={typeof code === "string" ? code.slice(0, 12) : ""} />;
}
