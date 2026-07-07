// Status bar line composition: one short string of ambient background
// state (scan > sweep > library stats). Pure so the priority rules are
// testable without rendering.

export interface SweepDetail {
  /** Tracks left in the running sweep. */
  remaining: number;
  /** Wall-clock ETA from the sweep's rolling mean, or null while the
      first few tracks are still seeding it. */
  etaMs: number | null;
}

export interface StatusInputs {
  tracks: number;
  /** Tracks with a recorded BPM verdict (bpm_analyzed_at set). */
  analyzed: number;
  scanning: boolean;
  /** Sweep state, or null when the sweep is idle. */
  sweep: SweepDetail | null;
  /** Title of the track the sweep is currently chewing (filename
      fallback resolved by the caller); null = none/unknown. */
  currentTitle: string | null;
  currentArtist: string | null;
  /** Active beat model label (e.g. "Standard"); shown only while a
      sweep runs, so a model switch's re-sweep names which engine is at
      work. Omitted/undefined keeps the line as it was. */
  modelLabel?: string;
}

const fmt = new Intl.NumberFormat("en-US");

/** Compact ETA: "~42m", "~9h 16m". Bare minutes under an hour, hours +
    minutes past it — matches the ambient one-line tone. */
export function formatEta(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `~${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `~${h}h ${m}m`;
}

export function statusLine(s: StatusInputs): string {
  if (s.scanning) return "Scanning…";
  if (s.sweep) {
    const head = s.modelLabel
      ? `Analyzing (${s.modelLabel})`
      : "Analyzing";
    const segs = [`${head} · ${fmt.format(s.sweep.remaining)} left`];
    if (s.sweep.etaMs != null) segs.push(formatEta(s.sweep.etaMs));
    if (s.currentTitle) {
      segs.push(s.currentArtist ? `${s.currentTitle} — ${s.currentArtist}` : s.currentTitle);
    }
    return segs.join(" · ");
  }
  if (s.tracks === 0) return "No tracks";
  if (s.analyzed >= s.tracks) return `${fmt.format(s.tracks)} tracks`;
  return `${fmt.format(s.tracks)} tracks · ${fmt.format(s.analyzed)} analyzed`;
}
