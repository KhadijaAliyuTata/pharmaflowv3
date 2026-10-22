/**
 * The PharmaFlow lockup: the cross mark and the wordmark.
 *
 * ## Why this is a component and not inline JSX
 *
 * `/join` and the sign-in screen need the same lockup, and duplicating a 50-line
 * inline SVG into a second file is the kind of copy that silently drifts: change
 * one arm colour and the two screens disagree, with nothing to fail a test. The
 * mark lives here once; `login.tsx` imports `BrandLogo` rather than keeping a
 * private copy.
 *
 * ## Why inline rather than an image file
 *
 * The left and bottom arms are `currentColor`, so they follow the theme. An inline
 * script in `__root` puts `.dark` on `<html>` before React hydrates, and an `<img>`
 * cannot read page CSS — a fixed-colour file would need a second copy for dark mode.
 * `currentColor` tracks both themes with one copy.
 *
 * The mark is a vector trace of the supplied artwork, so it stays sharp at any size
 * and needs no binary asset in the bundle.
 *
 * Colours come from the palette tokens (`--green-600`, `--navy-800`) reached
 * through Tailwind's `fill-*` / `stroke-*` utilities, which land as CSS
 * declarations on the SVG. A presentation attribute such as `fill="#2a932c"`
 * could not read a token.
 */
export function BrandMark({ className = 'size-8 shrink-0' }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 200" className={className} aria-hidden="true" focusable="false">
      {/* Green on the top and right arms, the inherited text colour on the
          left and bottom — the diagonal split the logo uses. */}
      <g className="fill-green-600">
        <rect x="72" y="20" width="56" height="82" rx="14" />
        <rect x="128" y="72" width="52" height="56" rx="14" />
      </g>
      <g fill="currentColor">
        <rect x="20" y="72" width="52" height="56" rx="14" />
        <rect x="72" y="128" width="56" height="52" rx="14" />
      </g>

      <circle cx="100" cy="100" r="44" fill="#fff" />

      {/* The circuit traces inside the cross, and the P they feed. Explicit
          colours here rather than currentColor: the white disc is a fixed
          light surface in both themes, so a theme-following fill would
          vanish against it. */}
      <g className="stroke-green-600" strokeWidth="5" strokeLinecap="round" fill="none">
        <path d="M60 76h12M60 106h10M128 76h12M130 106h10" />
      </g>
      <g className="fill-green-600">
        <circle cx="77" cy="76" r="5.5" />
        <circle cx="75" cy="106" r="5.5" />
        <circle cx="123" cy="76" r="5.5" />
        <circle cx="125" cy="106" r="5.5" />
      </g>
      <path
        d="M88 130V86h12a19 19 0 0 1 0 38H88"
        fill="none"
        className="stroke-navy-800"
        strokeWidth="12"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BrandLogo({ tagline = false }: { tagline?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <BrandMark />

      <div className="leading-tight">
        {/* Two-tone, matching the wordmark. `Pharma` inherits so it tracks the
            theme; `Flow` stays brand green, which reads on light and dark. */}
        <p className="text-base font-semibold tracking-tight">
          <span>Pharma</span>
          {/* `green-700`, not `green-600`: the literal brand green is 3.75:1 on
              the page background at this size, and the wordmark is real text in
              the accessibility tree even though it reads as a logo. The SVG
              fills stay `green-600` — they are graphics, where 3:1 applies. */}
          <span className="text-green-700">Flow</span>
        </p>
        {tagline && (
          <p className="text-[11px] text-muted-foreground">
            Smarter Pharmacies. Healthier Communities.
          </p>
        )}
      </div>
    </div>
  );
}
