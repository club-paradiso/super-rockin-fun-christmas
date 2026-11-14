import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentStaff } from "@/lib/staff-auth/page";
import { getBackend } from "@/lib/storage/server";
import { AdminNav } from "@/components/admin/admin-nav";
import { BrandWordmark } from "@/components/brand";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin · STUDIO SHALOM",
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
    settings.pauseSubmissions && "미디어월 게시 신청 중지",
    settings.pauseWall && "미디어월 일시정지",
    settings.showHoldingScreen && "대기 화면 표시",
  ].filter(Boolean) as string[];

  return (
    <div className="admin-root min-h-dvh bg-backdrop text-ink">
      {active.length > 0 && (
        <Link
          href="/admin/settings"
          data-testid="emergency-banner"
          className="block bg-danger px-4 py-2.5 text-center text-[15px] leading-snug font-bold text-button-text"
        >
          긴급 설정 작동 중: {active.join(" · ")}
        </Link>
      )}
      {/* The top bar scrolls away; only the tabs stay (a phone has no height to spare). */}
      <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-2 gap-y-1 px-4 pt-3 pb-1">
        <Link
          href="/admin"
          aria-label="STUDIO SHALOM Admin"
          className="flex items-baseline gap-1.5"
        >
          <BrandWordmark className="text-[15px]" />
          <span className="text-[13px] font-semibold text-ink/75">Admin</span>
        </Link>
        <div className="flex items-center gap-1 text-xs text-ink/75">
          <span data-testid="staff-name">{auth.staff.displayName}</span>
          <form method="post" action="/api/admin/auth/signout">
            <button
              type="submit"
              className="min-h-10 rounded-[10px] px-2 text-sm font-semibold text-ink underline decoration-ink/40 underline-offset-4 active:bg-ink/10"
            >
              로그아웃
            </button>
          </form>
        </div>
      </header>
      <AdminNav />
      <main className="mx-auto max-w-6xl px-4 py-5">{children}</main>
    </div>
  );
}
