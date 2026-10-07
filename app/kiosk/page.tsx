import type { Metadata } from "next";
import { KioskApp } from "@/components/kiosk/kiosk-app";
import { resolveCameraMode } from "@/lib/camera";

export const metadata: Metadata = {
  title: "FOLLOW THE LIGHTS · Photo Booth",
  robots: { index: false, follow: false },
};

export default async function KioskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { camera } = await searchParams;
  const cameraMode = resolveCameraMode(
    typeof camera === "string" ? camera : undefined,
    process.env.NEXT_PUBLIC_CAMERA_MODE,
  );
  return <KioskApp cameraMode={cameraMode} />;
}
