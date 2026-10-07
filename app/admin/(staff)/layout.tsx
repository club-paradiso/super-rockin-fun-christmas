import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentStaff } from "@/lib/staff-auth/page";
import { getBackend } from "@/lib/storage/server";
import { AdminNav } from "@/components/admin/admin-nav";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "운영 · FOLLOW THE LIGHTS",
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
    <div className="min-h-dvh bg-ink text-cream">
      {active.length > 0 && (
        <Link
          href="/admin/settings"
          data-testid="emergency-banner"
          className="block bg-alert px-4 py-3 text-center text-lg font-bold text-ink"
        >
          긴급 설정 작동 중: {active.join(" · ")}
        </Link>
      )}
      <header className="sticky top-0 z-10 border-b border-cream/10 bg-ink/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link href="/admin" className="text-lg font-bold tracking-[0.2em] text-amber">
            FOLLOW THE LIGHTS · 운영
          </Link>
          <div className="flex items-center gap-3 text-sm text-mist">
            <span data-testid="staff-name">{auth.staff.displayName}</span>
            <form method="post" action="/api/admin/auth/signout">
              <button
                type="submit"
                className="rounded-lg border border-cream/20 px-3 py-2 text-cream"
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
