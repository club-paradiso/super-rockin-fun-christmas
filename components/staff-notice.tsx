/** Staff-facing full-screen notice (not part of the guest flow). */
export function StaffNotice({
  title,
  children,
  testId,
}: {
  title: string;
  children?: React.ReactNode;
  testId: string;
}) {
  return (
    <main
      data-testid={testId}
      className="flex min-h-dvh flex-col items-center justify-center gap-6 px-8 text-center"
    >
      <p className="text-lg font-semibold tracking-[0.3em] text-ink/75">STAFF</p>
      <h1 className="text-4xl font-bold text-ink">{title}</h1>
      <div className="max-w-2xl text-xl leading-relaxed text-ink/75">{children}</div>
    </main>
  );
}
