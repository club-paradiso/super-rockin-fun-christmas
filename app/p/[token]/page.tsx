import type { Metadata } from "next";
import { getPhotoStore } from "@/lib/storage/server";
import { SaveTips } from "./save-tips";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "내 네컷 사진 · FOLLOW THE LIGHTS",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function PhotoPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const record = await getPhotoStore().get(token);

  if (!record) {
    return (
      <main className="night-sky flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-5xl" aria-hidden>
          ✦
        </p>
        <h1 className="text-2xl font-bold text-cream">사진을 찾을 수 없어요</h1>
        <p className="max-w-xs text-lg text-mist">
          링크가 만료되었거나 주소가 잘못되었어요. 사진은 정해진 기간 동안만 보관됩니다.
        </p>
      </main>
    );
  }

  const src = `/p/${encodeURIComponent(token)}/image`;
  const expires = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    hour: "numeric",
  }).format(new Date(record.expiresAt));

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
        <a
          href={`${src}?download=1`}
          download
          className="btn-primary w-full text-center"
          data-testid="download-button"
        >
          사진 저장하기
        </a>
        <SaveTips imageUrl={src} />
        <p className="text-center text-sm text-mist">
          이 링크는 {expires}까지 열 수 있어요. 필요한 사진은 꼭 저장해 주세요.
        </p>
      </div>
    </main>
  );
}
