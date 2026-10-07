import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { findGuestPhoto } from "@/lib/storage/guest";
import { SavePhoto } from "./save-photo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "내 네컷 사진 · FOLLOW THE LIGHTS",
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
    <main className="night-sky min-h-dvh px-5 pb-10 pt-8">
      <div className="mx-auto flex max-w-md flex-col items-center gap-6">
        <header className="text-center">
          <p className="text-sm tracking-[0.3em] text-amber">FOLLOW THE LIGHTS</p>
          <h1 className="mt-2 text-2xl font-bold text-cream">오늘의 네컷이 도착했어요</h1>
        </header>
        {/* eslint-disable-next-line @next/next/no-img-element -- private, uncached image */}
        <img
          src={src}
          alt="내 네컷 사진"
          className="max-h-[70dvh] w-auto rounded-lg shadow-[0_0_60px_rgba(255,200,120,0.18)]"
        />
        <SavePhoto imageUrl={src} mime={photo.mime} />
        <p className="text-center text-sm text-mist">
          {expires}까지 열 수 있어요. 꼭 저장해 주세요.
        </p>
      </div>
    </main>
  );
}
