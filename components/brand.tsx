/**
 * The STUDIO SHALOM lockup as real text (D73): STUDIO / SHALOM / a short thin divider / 평화의 벽,
 * stacked and centred. Sizes and fonts live in app/globals.css (.brand-lockup): 1em is the SHALOM
 * size, so set a font-size on `className` (e.g. `text-[56px]`). The frames carry the same lockup
 * as outlined SVG paths (public/frames/*-lockup.svg), because a canvas cannot use web fonts.
 */
export function BrandLockup({ className = "" }: { className?: string }) {
  return (
    <span className={`brand-lockup ${className}`} role="img" aria-label="STUDIO SHALOM · 평화의 벽">
      <span className="brand-lockup-studio" aria-hidden>
        Studio
      </span>
      <span className="brand-lockup-shalom" aria-hidden>
        Shalom
      </span>
      <span className="brand-lockup-rule" aria-hidden />
      <span className="brand-lockup-sub" aria-hidden>
        평화의 벽
      </span>
    </span>
  );
}

/** One line, for headers too small for the stacked lockup. Give it a font-size of 20 px or more. */
export function BrandWordmark({
  className = "",
  suffix,
}: {
  className?: string;
  /** e.g. "STAFF" on staff screens. */
  suffix?: string;
}) {
  return (
    <span className={`brand-wordmark ${className}`}>
      Studio Shalom{suffix ? ` · ${suffix}` : ""}
    </span>
  );
}
