import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { findGuestPhoto } from "@/lib/storage/guest";
import { BrandLockup } from "@/components/brand";
import { SavePhoto } from "./save-photo";
import { SaveVideo } from "./save-video";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "내 네컷 사진 · STUDIO SHALOM",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function PhotoPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const photo = await findGuestPhoto(token);
  if (!photo) notFound();

  const src = `/p/${encodeURIComponent(token)}/image`;
  const expires = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    hour: "numeric",
  }).format(new Date(photo.tokenExpiresAt));

  return (
    <main className="min-h-dvh px-5 pb-10 pt-8">
      <div className="mx-auto flex max-w-md flex-col items-center gap-6">
        <header className="text-center">
          <BrandLockup className="text-[52px]" />
          <h1 className="mt-5 text-2xl font-bold text-ink">오늘의 네컷이 도착했어요</h1>
        </header>
        {/* eslint-disable-next-line @next/next/no-img-element -- private, uncached image */}
        <img src={src} alt="내 네컷 사진" className="max-h-[70dvh] w-auto rounded-lg" />
        <SavePhoto imageUrl={src} mime={photo.mime} />
        {/* Only when the server really has this session's video (D72). */}
        {photo.video && (
          <SaveVideo videoUrl={`/p/${encodeURIComponent(token)}/video`} mime={photo.video.mime} />
        )}
        <p className="text-center text-sm text-ink/75">
          {expires}까지 열 수 있어요. 꼭 저장해 주세요.
        </p>
        <p className="text-center text-sm text-ink/75 [word-break:keep-all]">
          미디어월에 걸린 사진을 내리고 싶으면 부스 직원에게 말씀해 주세요.
        </p>
      </div>
    </main>
  );
}
