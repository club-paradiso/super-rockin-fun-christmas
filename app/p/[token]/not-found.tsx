/** Same page for unknown, expired and deleted links — never reveal which. */
export default function PhotoNotFound() {
  return (
    <main className="night-sky flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-5xl" aria-hidden>
        ✦
      </p>
      <h1 className="text-2xl font-bold text-cream">사진을 찾을 수 없어요</h1>
      <p className="max-w-xs text-lg text-mist">
        링크가 만료되었거나 주소가 잘못되었어요. 사진은 정해진 기간 동안만 보관됩니다.
      </p>
    </main>
  );
}
