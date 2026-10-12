import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServerConfig } from "@/lib/server/env";
import { currentStaff } from "@/lib/staff-auth/page";
import { ensureSetupCode } from "@/lib/staff-auth/setup";
import { getBackend } from "@/lib/storage/server";
import { LoginForm } from "./login-form";
import { HubSetupForm, PinLoginForm } from "./pin-login-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "스태프 로그인 · FOLLOW THE LIGHTS",
  robots: { index: false, follow: false },
};

const DENIED: Record<string, string> = {
  not_staff: "이 계정은 스태프 명단에 없어요. 운영 책임자에게 문의하세요.",
  inactive: "비활성화된 스태프 계정이에요. 운영 책임자에게 문의하세요.",
  not_configured: "스태프 로그인이 설정되지 않았어요 (Supabase 또는 FTL_ROLE=hub 필요).",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await currentStaff();
  if (auth.ok) redirect("/admin");
  const { denied } = await searchParams;
  const staffAuth = getServerConfig().staffAuth;
  const notice =
    typeof denied === "string"
      ? DENIED[denied]
      : auth.reason !== "unauthenticated"
        ? DENIED[auth.reason]
        : null;

  return (
    <main className="night-sky flex min-h-dvh items-center justify-center px-5 py-10">
      <div className="w-full max-w-md">
        <p className="text-sm tracking-[0.3em] text-amber">FOLLOW THE LIGHTS · STAFF</p>
        <h1 className="mt-2 text-3xl font-bold text-cream">스태프 로그인</h1>
        {notice && (
          <p
            role="status"
            className="mt-4 rounded-xl bg-alert/20 p-4 text-lg text-cream"
            data-testid="login-denied"
          >
            {notice}
          </p>
        )}
        {staffAuth?.mode === "pin" ? (
          await hubLogin()
        ) : staffAuth ? (
          <LoginForm />
        ) : (
          <p className="mt-6 text-lg text-mist">{DENIED.not_configured}</p>
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
