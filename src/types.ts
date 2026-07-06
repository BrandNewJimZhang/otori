// Mirror of otori-core's serialized types. If these drift from the Rust
// side the IPC calls fail loudly, not silently — keep them in sync with
// crates/otori-core (query::TrackRow, scan::ScanReport).

export interface TrackRow {
  id: number;
  path: string;
  format: string;
  duration_secs: number | null;
  replaygain_db: number | null;
  bpm: number | null;
  bpm_max: number | null;
  bpm_confidence: number | null;
  bpm_hint: number | null;
  title: string | null;
  artist: string | null;
  album: string | null;
}

export interface ScanReport {
  added: number;
  updated: number;
  skipped_icloud: string[];
  unreadable: string[];
}

// Mirrors otori_core::lyrics (LyricsDoc / Line / Word).
export type LyricsKind = "word_synced" | "line_synced" | "static";

export interface LyricsWord {
  time_ms: number;
  text: string;
}

export interface LyricsLine {
  time_ms: number;
  text: string;
  words?: LyricsWord[];
}

export interface LyricsDoc {
  kind: LyricsKind;
  source: "embedded" | "sidecar";
  lines: LyricsLine[];
}
