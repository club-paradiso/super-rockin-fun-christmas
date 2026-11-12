/**
 * The STUDIO SHALOM lockup as real text (D73): STUDIO / SHALOM / a short thin divider / 평화의 벽,
 * stacked and centred. Sizes and fonts live in app/globals.css (.brand-lockup): 1em is the SHALOM
 * size, so set a font-size on `className` (e.g. `text-[56px]`). The frames carry the same lockup
 * as outlined SVG paths (public/frames/*-lockup.svg), because a canvas cannot use web fonts.
 *
 * The O of SHALOM holds a four-pointed star (D77), as the O of FOLLOW THE LIGHTS once did. On
 * screen it is drawn over the real letter, so the text stays "SHALOM" for copy and search.
 */
export function BrandLockup({ className = "" }: { className?: string }) {
  return (
    <span className={`brand-lockup ${className}`} role="img" aria-label="STUDIO SHALOM · 평화의 벽">
      <span className="brand-lockup-studio" aria-hidden>
        Studio
      </span>
      <span className="brand-lockup-shalom" aria-hidden>
        Shal
        <StarO />m
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
      Studio Shal
      <StarO />m{suffix ? ` · ${suffix}` : ""}
    </span>
  );
}

/** The letter O with the star in its counter. The star is decoration (hidden from assistive tech). */
function StarO() {
  return (
    <span className="brand-o" data-testid="brand-o">
      o
      <svg className="brand-o-star" viewBox="0 0 63 100" aria-hidden focusable="false">
        <path d="M31.5 0C33.6 33 38 44 63 50C38 56 33.6 67 31.5 100C29.4 67 25 56 0 50C25 44 29.4 33 31.5 0Z" />
      </svg>
    </span>
  );
}
