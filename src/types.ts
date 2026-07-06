// Mirror of otori-core's serialized types. If these drift from the Rust
// side the IPC calls fail loudly, not silently — keep them in sync with
// crates/otori-core (query::TrackRow, scan::ScanReport).

export interface TrackRow {
  id: number;
  path: string;
  format: string;
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
