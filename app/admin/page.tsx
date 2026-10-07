import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "FOLLOW THE LIGHTS · Admin",
  robots: { index: false, follow: false },
};

const PLANNED = [
  ["검수 대기 사진", "pending photos · approve · reject"],
  ["게시 관리", "hide · restore · delete"],
  ["최근 세션", "recent sessions"],
  ["상태", "kiosk health · wall health · storage"],
  ["비상 제어", "PAUSE SUBMISSIONS · PAUSE MEDIA WALL · SHOW HOLDING SCREEN"],
] as const;

/** Placeholder. Moderation lands in Phase 3 (needs auth + Supabase first). */
export default function AdminPage() {
  return (
    <main className="min-h-dvh bg-ink px-8 py-10 text-cream">
      <h1 className="text-3xl font-bold">FOLLOW THE LIGHTS — 운영</h1>
      <p className="mt-2 text-mist">아직 준비 중입니다. 검수 기능은 Phase 3에서 구현됩니다.</p>
      <ul className="mt-8 grid max-w-3xl gap-3">
        {PLANNED.map(([ko, en]) => (
          <li key={ko} className="rounded-xl border border-cream/15 px-5 py-4">
            <p className="text-lg font-semibold">{ko}</p>
            <p className="text-sm text-mist">{en}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
