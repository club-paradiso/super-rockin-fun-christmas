import "server-only";
import { timingSafeEqual } from "node:crypto";
import { generateEnrollmentCode, normalizeEnrollmentCode } from "@/lib/ops/enrollment-code";
import { getServerConfig } from "@/lib/server/env";
import { getBackend } from "@/lib/storage/server";

/**
 * First staff member on a fresh hub. While the hub has no staff at all, a one-time setup code is
 * printed in the hub's own console window (the laptop at the booth). Whoever can read that screen
 * may create the first staff member at /admin/login; later staff are added in /admin → 설정.
 *
 * The code lives only in this process's memory (globalThis, because Next.js bundles each route
 * separately) and stops working as soon as one staff member exists.
 */
type SetupState = { code: string | null; busy: Promise<unknown> };
const state = ((globalThis as { __ftlHubSetup?: SetupState }).__ftlHubSetup ??= {
  code: null,
  busy: Promise.resolve(),
});

export async function hubNeedsSetup(): Promise<boolean> {
  if (getServerConfig().staffAuth?.mode !== "pin") return false;
  return (await getBackend().staff.list()).length === 0;
}

/** The current setup code (printed once to the console when created), or null when not needed. */
export async function ensureSetupCode(): Promise<string | null> {
  if (!(await hubNeedsSetup())) {
    state.code = null;
    return null;
  }
  if (!state.code) {
    state.code = testSetupCode() ?? normalizeEnrollmentCode(generateEnrollmentCode());
    const shown = `${state.code!.slice(0, 4)}-${state.code!.slice(4)}`;
    console.log(
      [
        "",
        "==================================================",
        "  FOLLOW THE LIGHTS 허브: 첫 스태프 설정 코드",
        `      ${shown}`,
        "  스태프 휴대폰에서 /admin/login 을 열고 이 코드를 입력하세요.",
        "  첫 스태프를 만들면 이 코드는 더 이상 쓸 수 없어요.",
        "==================================================",
        "",
      ].join("\n"),
    );
  }
  return state.code;
}

/**
 * The E2E suite cannot read the server console, so it may fix the code with FTL_HUB_SETUP_CODE.
 * Honoured only together with the E2E-only FTL_ALLOW_LOCAL_ORIGIN escape hatch, never on Vercel.
 */
function testSetupCode(): string | null {
  const env = process.env;
  if (env.FTL_ALLOW_LOCAL_ORIGIN !== "1" || env.VERCEL_ENV) return null;
  return normalizeEnrollmentCode(env.FTL_HUB_SETUP_CODE ?? "");
}

/**
 * Run `create` only if `input` is the live setup code and the hub still has no staff. Serialized,
 * so two phones racing the same code cannot both create a first staff member.
 */
export function withSetupCode<T>(input: string, create: () => Promise<T>): Promise<T | null> {
  const run = state.busy.then(async () => {
    const given = normalizeEnrollmentCode(input);
    const code = state.code;
    if (!given || !code || !(await hubNeedsSetup())) return null;
    if (!timingSafeEqual(Buffer.from(given), Buffer.from(code))) return null;
    const result = await create();
    state.code = null;
    return result;
  });
  state.busy = run.catch(() => undefined);
  return run;
}
