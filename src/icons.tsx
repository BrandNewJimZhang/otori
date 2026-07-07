// Inline SVG transport icons: text glyphs (▶ ⏸) sit on font baselines
// and drift per font fallback; fixed-viewBox SVGs center optically.

const P = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "currentColor",
  "aria-hidden": true,
} as const;

export function PlayIcon() {
  // Nudged right of center: a centered triangle looks left-heavy.
  return (
    <svg {...P}>
      <path d="M9 5.5v13a.5.5 0 0 0 .77.42l10-6.5a.5.5 0 0 0 0-.84l-10-6.5A.5.5 0 0 0 9 5.5z" transform="translate(-2 0)" />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg {...P}>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

/** Inspector toggle: an ⓘ info circle (mac "Get Info" convention). */
export function InfoIcon() {
  return (
    <svg {...P}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" fill="none" />
      <circle cx="12" cy="7.8" r="1.3" />
      <rect x="10.9" y="10.5" width="2.2" height="7" rx="1.1" />
    </svg>
  );
}

export function PrevIcon() {
  return (
    <svg {...P}>
      <rect x="5" y="5" width="2.5" height="14" rx="1" />
      <path d="M19 5.7v12.6a.5.5 0 0 1-.78.41l-9.1-6.3a.5.5 0 0 1 0-.82l9.1-6.3a.5.5 0 0 1 .78.41z" />
    </svg>
  );
}

export function NextIcon() {
  return (
    <svg {...P}>
      <rect x="16.5" y="5" width="2.5" height="14" rx="1" />
      <path d="M5 5.7v12.6a.5.5 0 0 0 .78.41l9.1-6.3a.5.5 0 0 0 0-.82l-9.1-6.3A.5.5 0 0 0 5 5.7z" />
    </svg>
  );
}

export function ShuffleIcon() {
  return (
    <svg {...P}>
      <path
        d="M4 7h3l3 4m0 2 3 4h4m0 0-2-2m2 2-2 2M4 17h3l2.4-3.2M13 7h4m0 0-2-2m2 2-2 2"
        stroke="currentColor"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function RepeatIcon({ one = false }: { one?: boolean }) {
  return (
    <svg {...P}>
      <path
        d="M7 6h8a4 4 0 0 1 4 4v1M17 18H9a4 4 0 0 1-4-4v-1m2-7L5 8l2 2m10 6 2 2-2 2"
        stroke="currentColor"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {one && (
        <text x="12" y="14.5" textAnchor="middle" fontSize="8" fontWeight="700" fill="currentColor" stroke="none">
          1
        </text>
      )}
    </svg>
  );
}

export function SunIcon() {
  return (
    <svg {...P}>
      <circle cx="12" cy="12" r="4.2" />
      <path
        d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MoonIcon() {
  return (
    <svg {...P}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" />
    </svg>
  );
}

export function VolumeIcon() {
  return (
    <svg {...P}>
      <path d="M4 9.5v5a1 1 0 0 0 1 1h2.6l4.6 3.6a.5.5 0 0 0 .8-.4V5.3a.5.5 0 0 0-.8-.4L7.6 8.5H5a1 1 0 0 0-1 1z" />
      <path d="M15.5 8.7a4.5 4.5 0 0 1 0 6.6" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <path d="M17.8 6.2a7.5 7.5 0 0 1 0 11.6" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/** Row-density toggle: three lines spaced wide (comfortable) or tight (compact). */
export function DensityIcon({ compact }: { compact: boolean }) {
  const ys = compact ? [7, 12, 17] : [5, 12, 19];
  return (
    <svg {...P}>
      {ys.map((y) => (
        <rect key={y} x="4" y={y - 1} width="16" height="2" rx="1" />
      ))}
    </svg>
  );
}

/** Stage-mode entry: a proscenium arch over a spotlight beam. */
export function StageIcon() {
  return (
    <svg {...P}>
      <path
        d="M4 10a8 8 0 0 1 16 0"
        stroke="currentColor"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
      />
      <path d="M12 9.5 8 19h8l-4-9.5z" opacity="0.85" />
      <rect x="3" y="19" width="18" height="1.8" rx="0.9" />
    </svg>
  );
}

/** Sort direction chevron (audit r5 P3: ▲▼ text glyphs drift per
    font fallback — the exact failure icons.tsx exists to prevent). */
export function SortArrowIcon({ dir }: { dir: 1 | -1 }) {
  return (
    <svg {...P} width={10} height={10}>
      <path
        d={dir === 1 ? "M12 6 4 16h16L12 6z" : "M12 18 4 8h16l-8 10z"}
      />
    </svg>
  );
}

/** Auto (follow-system) theme: half sun, half moon. */
export function AutoThemeIcon() {
  return (
    <svg {...P}>
      <path d="M12 3a9 9 0 0 0 0 18V3z" />
      <path
        d="M12 3a9 9 0 0 1 0 18"
        stroke="currentColor"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Up-next queue toggle: a list with a play wedge on the top row. */
export function QueueIcon() {
  return (
    <svg {...P}>
      <path d="M4 6.5 9 9.25 4 12V6.5z" />
      <path
        d="M12 8h8M4 14.5h16M4 19h16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Brand mark for the toolbar: same geometry as docs/assets/logo-mark-*.svg.
    Ring rides currentColor so it flips with the theme (light ring on dark
    Backstage, ink ring on the light variant); feathers keep the fixed brand
    palette (docs/design/logo.md). */
export function BrandMark() {
  const short = "M 0 0 C 30 -60 30 -166 0 -224 C -30 -166 -30 -60 0 0 Z";
  const long = "M 0 0 C 30 -64 30 -178 0 -238 C -30 -178 -30 -64 0 0 Z";
  return (
    <svg width="22" height="22" viewBox="84 92 400 400" aria-hidden>
      <defs>
        <mask id="brand-ring-hole">
          <rect x="84" y="92" width="400" height="400" fill="white" />
          <circle cx="226" cy="350" r="96" fill="black" />
        </mask>
      </defs>
      {/* Mask and translate on separate groups: userSpaceOnUse mask coords
          are re-mapped by the masked element's own transform, which shifts
          the white rect off the feathers and blanks them. */}
      <g mask="url(#brand-ring-hole)">
        <g transform="translate(226 350)">
          <path d={short} fill="#FFBB00" transform="rotate(-14)" />
          <path d={long} fill="#FF66BB" transform="rotate(16)" />
          <path d={long} fill="#33DD99" transform="rotate(46)" />
          <path d={short} fill="#BB88EE" transform="rotate(76)" />
        </g>
      </g>
      <circle cx="226" cy="350" r="96" fill="none" stroke="currentColor" strokeWidth="44" />
    </svg>
  );
}

/** Placeholder for a track with no embedded cover: a plain eighth note. */
export function NoteIcon() {
  return (
    <svg {...P}>
      <path
        d="M9 17V6l9-2v9"
        stroke="currentColor"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="6.5" cy="17" r="2.5" />
      <circle cx="15.5" cy="15" r="2.5" />
    </svg>
  );
}
