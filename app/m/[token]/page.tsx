import type { Metadata } from "next";
import { readUploadToken } from "@/lib/mobile/server";
import { getPhotoService } from "@/lib/storage/server";
import { MobileUpload } from "./mobile-upload";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "내 사진으로 참여하기 · FOLLOW THE LIGHTS",
  robots: { index: false, follow: false },
  // The QR token is in this address; never send it to another site.
  referrer: "no-referrer",
};

/**
 * Guest phone page for "내 사진으로 참여하기" (D66). Opened from the booth QR; no install, no
 * account. Unknown, forged and expired QR codes all get the same page.
 */
export default async function MobileUploadPage({ params }: { params: Promise<{ token: string }> }) {
  const token = safeDecode((await params).token);
  const verified = readUploadToken(token);
  if (!verified.ok) return <Closed testId="mobile-expired" />;
  const status = await getPhotoService().mobileStatus(
    verified.claims.sessionId,
    verified.claims.kioskId,
  );
  if (status === "closed") return <Closed testId="mobile-expired" />;
  return (
    <MobileUpload
      token={token}
      expiresAt={new Date(verified.claims.expiresAt * 1000).toISOString()}
      alreadySent={status === "received"}
    />
  );
}

/** Tokens are URL-safe; a broken %-sequence is simply an unusable QR, not a server error. */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

function Closed({ testId }: { testId: string }) {
  return (
    <main className="night-sky flex min-h-dvh items-center px-5 py-10" data-testid={testId}>
      <div className="mx-auto flex max-w-md flex-col items-center gap-5 text-center">
        <p className="text-sm tracking-[0.3em] text-amber">FOLLOW THE LIGHTS</p>
        <h1 className="text-2xl font-bold text-cream">이 QR은 더 이상 쓸 수 없어요</h1>
        <p className="text-lg leading-relaxed text-mist">
          시간이 지났거나 이미 쓴 QR이에요.
          <br />
          포토부스 화면에서 &lsquo;내 사진으로 참여하기&rsquo;를 다시 눌러 새 QR을 받아 주세요.
        </p>
      </div>
    </main>
  );
}
