import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentStaff } from "@/lib/staff-auth/page";
import { getBackend } from "@/lib/storage/server";
import { AdminNav } from "@/components/admin/admin-nav";
import { BrandWordmark } from "@/components/brand";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "운영 · STUDIO SHALOM",
  robots: { index: false, follow: false },
  // No per-page "no-referrer": it makes browsers send `Origin: null` on POSTs, and older Safari
  // (no Sec-Fetch-Site) would then fail the CSRF check. The global policy is "same-origin".
};

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const auth = await currentStaff();
  if (!auth.ok)
    redirect(
      auth.reason === "unauthenticated" ? "/admin/login" : `/admin/login?denied=${auth.reason}`,
    );
  const settings = await getBackend().settings.get();
  const active = [
    settings.pauseSubmissions && "미디어월 참여 중지",
    settings.pauseWall && "미디어월 일시정지",
    settings.showHoldingScreen && "대기 화면 표시",
  ].filter(Boolean) as string[];

  return (
    <div className="min-h-dvh bg-backdrop text-ink">
      {active.length > 0 && (
        <Link
          href="/admin/settings"
          data-testid="emergency-banner"
          className="block bg-danger px-4 py-3 text-center text-lg font-bold text-button-text"
        >
          긴급 설정 작동 중: {active.join(" · ")}
        </Link>
      )}
      <header className="sticky top-0 z-10 border-b border-ink/15 bg-backdrop">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link href="/admin" aria-label="STUDIO SHALOM 운영">
            <BrandWordmark className="text-[22px]" />
            <span className="ml-3 text-base font-semibold text-ink/75">운영</span>
          </Link>
          <div className="flex items-center gap-3 text-sm text-ink/75">
            <span data-testid="staff-name">{auth.staff.displayName}</span>
            <form method="post" action="/api/admin/auth/signout">
              <button
                type="submit"
                className="rounded-full border border-ink/60 px-4 py-2 text-ink"
              >
                로그아웃
              </button>
            </form>
          </div>
        </div>
        <AdminNav />
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
