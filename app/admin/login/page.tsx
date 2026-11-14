import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServerConfig } from "@/lib/server/env";
import { currentStaff } from "@/lib/staff-auth/page";
import { ensureSetupCode } from "@/lib/staff-auth/setup";
import { getBackend } from "@/lib/storage/server";
import { BrandLockup } from "@/components/brand";
import Link from "next/link";
import { LoginForm } from "./login-form";
import { PasswordLoginForm } from "./password-login-form";
import { HubSetupForm, PinLoginForm } from "./pin-login-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "관리자 로그인 · STUDIO SHALOM",
  robots: { index: false, follow: false },
};

const DENIED: Record<string, string> = {
  not_staff: "이 계정은 스태프 명단에 없어요. 운영 책임자에게 문의하세요.",
  inactive: "비활성화된 스태프 계정이에요. 운영 책임자에게 문의하세요.",
  not_configured:
    "스태프 로그인이 아직 설정되지 않았어요. 기술 담당에게 문의하세요. (Supabase 또는 FTL_ROLE=hub 필요)",
};

/** Why the shared password login is off (shown instead of a field that could never work). */
const PASSWORD_OFF: Record<string, string> = {
  no_password:
    "키오스크 등록 비밀번호가 설정되지 않아 비밀번호 로그인을 쓸 수 없어요. 기술 담당에게 문의하세요. (KIOSK_ENROLL_SECRET)",
  password_too_short:
    "키오스크 등록 비밀번호가 12자보다 짧아 관리자 로그인에는 쓸 수 없어요. 기술 담당에게 12자 이상으로 바꿔 달라고 하세요. (KIOSK_ENROLL_SECRET)",
  auth_disabled: "개발 모드에서는 비밀번호 로그인을 쓸 수 없어요. (KIOSK_AUTH_DISABLED=1)",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await currentStaff();
  if (auth.ok) redirect("/admin");
  const { denied, staff: staffParam } = await searchParams;
  const config = getServerConfig();
  const staffAuth = config.staffAuth;
  // The shared password is the primary way in (D84). The personal staff login (email code on the
  // cloud, name + PIN on the hub) stays as a fallback behind one link, and is all there is when
  // no usable password is configured.
  const legacy = staffParam === "1" || !config.sharedAdmin;
  const notice =
    typeof denied === "string"
      ? DENIED[denied]
      : auth.reason !== "unauthenticated" && auth.reason !== "not_configured"
        ? DENIED[auth.reason]
        : null;

  return (
    <main className="admin-login">
      <div className="admin-login-card">
        <div className="flex justify-center">
          <BrandLockup className="admin-login-lockup" />
        </div>
        <h1 className="mt-8 text-center text-3xl font-bold text-ink">
          {legacy && config.sharedAdmin ? "스태프 로그인" : "관리자 로그인"}
        </h1>
        {notice && (
          <p
            role="status"
            className="mt-4 rounded-lg border border-danger/50 bg-paper p-4 text-lg text-ink"
            data-testid="login-denied"
          >
            {notice}
          </p>
        )}
        {!legacy ? (
          <PasswordLoginForm />
        ) : (
          <>
            {!config.sharedAdmin && config.sharedAdminProblem && (
              <p className="mt-4 text-base text-ink/75" data-testid="login-password-off">
                {PASSWORD_OFF[config.sharedAdminProblem]}
              </p>
            )}
            {staffAuth?.mode === "pin" ? (
              await hubLogin()
            ) : staffAuth ? (
              <LoginForm />
            ) : (
              <p className="mt-6 text-lg text-ink/75">{DENIED.not_configured}</p>
            )}
          </>
        )}
        {config.sharedAdmin && staffAuth && (
          <p className="mt-8 text-center text-base">
            <Link
              href={legacy ? "/admin/login" : "/admin/login?staff=1"}
              className="inline-flex min-h-12 items-center px-3 text-ink underline underline-offset-4"
              data-testid="login-switch"
            >
              {legacy
                ? "비밀번호로 로그인"
                : staffAuth.mode === "pin"
                  ? "이름과 PIN으로 로그인"
                  : "스태프 이메일 코드로 로그인"}
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}

/** Hub: pick your name and type your PIN, or create the first staff member on a fresh hub. */
async function hubLogin() {
  // Prints the one-time setup code in the hub console while the hub has no staff.
  if (await ensureSetupCode()) return <HubSetupForm />;
  const staff = (await getBackend().staff.list())
    .filter((s) => s.active)
    .map(({ userId, displayName }) => ({ userId, displayName }));
  return <PinLoginForm staff={staff} />;
}
