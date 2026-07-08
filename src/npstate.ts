// Now-playing mirror for the tray mini panel. The main window owns the
// playback engine; the mini window is a remote display. This payload is
// the entire contract between them — broadcast as the `np-state` Tauri
// event on every track / pause / artwork change (positions ride the
// separate 4Hz `np-pos` event so artwork bytes aren't re-sent per tick).

import type { TrackRow } from "./types";
import { displayTitle } from "./library";

export interface NpState {
  /** Display title, or null when nothing is playing. */
  title: string | null;
  artist: string | null;
  paused: boolean;
  /** Cover art data URL; null while loading or absent. */
  artwork: string | null;
  /** Track duration in seconds; null until engine metadata loads. */
  durationSecs: number | null;
}

export function buildNpState(
  current: TrackRow | null,
  paused: boolean,
  artwork: string | null,
  durationSecs: number,
): NpState {
  if (!current) return { title: null, artist: null, paused: true, artwork: null, durationSecs: null };
  return {
    title: displayTitle(current),
    artist: current.artist ?? null,
    paused,
    artwork,
    durationSecs: Number.isFinite(durationSecs) ? durationSecs : null,
  };
}
