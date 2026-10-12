import type { Metadata } from "next";
import { cookies } from "next/headers";
import { authenticateKiosk } from "@/lib/kiosk-auth/server";
import { KIOSK_COOKIE } from "@/lib/kiosk-auth/session";
import { getServerConfig } from "@/lib/server/env";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "키오스크 등록 · FOLLOW THE LIGHTS",
  robots: { index: false, follow: false },
};

const ERRORS: Record<string, string> = {
  "401": "등록 코드가 맞지 않거나, 이미 사용됐거나, 만료됐어요.",
  "409": "이 환경에서는 기기 등록이 꺼져 있어요 (개발 모드).",
  "429": "시도가 너무 많아요. 15분 뒤에 다시 해 주세요.",
};

/** Staff-only. Enrolls this browser as a kiosk with an HttpOnly session cookie. */
export default async function EnrollPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { error, next } = await searchParams;
  const toWall = next === "wall";
  const config = getServerConfig();
  const legacySecret = config.kioskAuth.mode === "required" && !!config.kioskAuth.enrollSecret;
  const auth = await authenticateKiosk((await cookies()).get(KIOSK_COOKIE)?.value ?? null);

  return (
    <main className="min-h-dvh bg-ink px-8 py-12 text-cream">
      <div className="mx-auto flex max-w-xl flex-col gap-8">
        <header>
          <p className="text-sm tracking-[0.3em] text-amber">STAFF · FOLLOW THE LIGHTS</p>
          <h1 className="mt-2 text-3xl font-bold">
            {toWall ? "미디어월 화면 등록" : "키오스크 기기 등록"}
          </h1>
          <p className="mt-3 text-mist">
            {toWall
              ? "이 브라우저를 미디어월 화면으로 등록합니다. 등록은 기기마다 한 번만 하면 되고, 브라우저를 다시 켜도 유지돼요."
              : "이 브라우저를 촬영 키오스크로 등록합니다. 등록은 기기마다 한 번만 하면 되고, 브라우저를 다시 켜도 유지돼요."}
          </p>
        </header>

        {auth.ok ? (
          <section data-testid="enroll-status" className="rounded-2xl border border-amber/40 p-6">
            <p className="text-xl">
              등록됨: <strong>{auth.label}</strong>
            </p>
            <div className="mt-6 flex flex-wrap gap-4">
              <a href={toWall ? "/wall" : "/kiosk"} className="btn-primary">
                {toWall ? "미디어월 열기" : "키오스크 열기"}
              </a>
              <form method="post" action="/api/kiosk/signout">
                <button type="submit" className="btn-secondary">
                  이 기기 등록 해제
                </button>
              </form>
            </div>
          </section>
        ) : (
          <div className="flex flex-col gap-8">
            <form
              method="post"
              action="/api/kiosk/enroll"
              className="flex flex-col gap-5"
              data-testid="enroll-code-form"
            >
              {toWall && <input type="hidden" name="next" value="wall" />}
              <label className="flex flex-col gap-2 text-lg">
                등록 코드
                <input
                  name="code"
                  required
                  autoComplete="off"
                  autoCapitalize="characters"
                  placeholder="예: K7QM-3XRP"
                  className="rounded-xl bg-night px-4 py-4 text-center font-mono text-3xl tracking-[0.2em] text-cream"
                />
              </label>
              <p className="text-base text-mist">
                운영 화면(/admin → 키오스크)에서 만든 일회용 코드예요. 15분 동안 한 번만 쓸 수
                있어요.
              </p>
              {typeof error === "string" && (
                <p role="alert" className="text-lg text-alert">
                  {ERRORS[error] ?? "등록하지 못했어요."}
                </p>
              )}
              <button type="submit" className="btn-primary">
                이 기기 등록
              </button>
            </form>
            {legacySecret && (
              <details
                className="rounded-2xl border border-cream/15 p-4"
                data-testid="enroll-secret-details"
              >
                <summary className="cursor-pointer text-lg text-mist">
                  공유 비밀번호로 등록 (구버전)
                </summary>
                <form
                  method="post"
                  action="/api/kiosk/enroll"
                  className="mt-4 flex flex-col gap-5"
                  data-testid="enroll-form"
                >
                  {toWall && <input type="hidden" name="next" value="wall" />}
                  <label className="flex flex-col gap-2 text-lg">
                    기기 이름
                    <input
                      name="label"
                      required
                      maxLength={40}
                      placeholder="예: 본당 입구 키오스크"
                      className="rounded-xl bg-night px-4 py-4 text-xl text-cream"
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-lg">
                    등록 비밀번호
                    <input
                      name="secret"
                      type="password"
                      required
                      autoComplete="off"
                      className="rounded-xl bg-night px-4 py-4 text-xl text-cream"
                    />
                  </label>
                  <button type="submit" className="btn-secondary">
                    비밀번호로 등록
                  </button>
                </form>
              </details>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
