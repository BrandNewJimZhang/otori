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

export function VolumeIcon() {
  return (
    <svg {...P}>
      <path d="M4 9.5v5a1 1 0 0 0 1 1h2.6l4.6 3.6a.5.5 0 0 0 .8-.4V5.3a.5.5 0 0 0-.8-.4L7.6 8.5H5a1 1 0 0 0-1 1z" />
      <path d="M15.5 8.7a4.5 4.5 0 0 1 0 6.6" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <path d="M17.8 6.2a7.5 7.5 0 0 1 0 11.6" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    </svg>
  );
}
