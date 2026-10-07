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
      className="night-sky flex min-h-dvh flex-col items-center justify-center gap-6 px-8 text-center"
    >
      <p className="text-lg tracking-[0.3em] text-amber">STAFF</p>
      <h1 className="text-4xl font-bold text-cream">{title}</h1>
      <div className="max-w-2xl text-xl leading-relaxed text-mist">{children}</div>
    </main>
  );
}
