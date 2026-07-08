// Status bar line composition: one short string of ambient background
// state (scan > sweep > library stats). Pure so the priority rules are
// testable without rendering.

export interface StatusInputs {
  tracks: number;
  /** Tracks with a recorded BPM verdict (bpm_analyzed_at set). */
  analyzed: number;
  scanning: boolean;
  /** Tracks left in the running sweep; null = sweep idle. */
  sweepRemaining: number | null;
  /** Active beat model label (e.g. "Standard"); shown only while a
      sweep runs, so a model switch's re-sweep names which engine is at
      work. Omitted/undefined keeps the line as it was. */
  modelLabel?: string;
}

const fmt = new Intl.NumberFormat("en-US");

export function statusLine(s: StatusInputs): string {
  if (s.scanning) return "Scanning…";
  if (s.sweepRemaining != null) {
    return s.modelLabel
      ? `Analyzing (${s.modelLabel}) · ${fmt.format(s.sweepRemaining)} left`
      : `Analyzing · ${fmt.format(s.sweepRemaining)} left`;
  }
  if (s.tracks === 0) return "No tracks";
  if (s.analyzed >= s.tracks) return `${fmt.format(s.tracks)} tracks`;
  return `${fmt.format(s.tracks)} tracks · ${fmt.format(s.analyzed)} analyzed`;
}
