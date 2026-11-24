/**
 * The one line staff read in the booth's help menu under 「사진 색 보정」: is this tablet applying
 * looks, and if not, why. Pure, so every case is tested (tests/unit/looks-status.test.ts).
 */
export interface LooksStatusInput {
  /** The staff switch as the booth last heard it. */
  staffSwitch: boolean;
  /** What the guest now at the booth runs with (a change waits for the next guest). */
  session: boolean;
  /** `?looks=1` / `?looks=0` in this tablet's address, or null. */
  override: boolean | null;
  /** The build has NEXT_PUBLIC_LOOKS=1. */
  buildFlag: boolean;
  /** The LUTs are in. */
  loaded: boolean;
  /** Why WebGL could not apply a look, once it has failed. */
  problem: string | null;
}

export type LooksState = "on" | "off" | "loading" | "failed";

export function looksStatus(input: LooksStatusInput): { state: LooksState; text: string } {
  const { staffSwitch, session, override, buildFlag, loaded, problem } = input;
  if (override === false)
    return { state: "off", text: "꺼짐 · 이 태블릿은 주소(?looks=0)로 꺼 두었어요." };
  const forced = override === true || buildFlag;
  const active = forced || session;
  if (!active)
    return {
      state: "off",
      text: staffSwitch ? "꺼짐 · 다음 손님부터 켜져요." : "꺼짐 · 관리자 화면에서 켤 수 있어요.",
    };
  if (problem)
    return {
      state: "failed",
      text: `적용 안 됨 · 이 태블릿에서는 색 보정을 쓸 수 없어요. 사진은 예전 색으로 나가요. (${problem})`,
    };
  if (!loaded) return { state: "loading", text: "준비 중…" };
  if (override === true)
    return { state: "on", text: "켜짐 · 이 태블릿은 주소(?looks=1)로 켜 두었어요." };
  if (!forced && !staffSwitch) return { state: "on", text: "켜짐 · 다음 손님부터 꺼져요." };
  return { state: "on", text: "켜짐" };
}
