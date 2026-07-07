// Typed IPC surface — the only place `invoke` is called (SSOT for the
// frontend↔shell contract).

import { invoke } from "@tauri-apps/api/core";
import type { LyricsDoc, ScanReport, TrackRow } from "./types";

export function scanLibrary(dir: string): Promise<ScanReport> {
  return invoke<ScanReport>("scan_library", { dir });
}

export function listTracks(): Promise<TrackRow[]> {
  return invoke<TrackRow[]>("list_tracks");
}

// ---- tag inspector (design: docs/design/tag-inspector.md) ----

export type WritableField = "title" | "artist" | "album";

export interface FieldChange {
  field: WritableField;
  value: string;
}

/** Per-field trust state (mirrors query::TagProvenance). */
export interface TagProvenance {
  field: string;
  value: string | null;
  source: "human" | "agent" | "import" | "inferred";
  curated: boolean;
  written_by: string | null;
  written_at: string;
}

export function getTagProvenance(trackId: number): Promise<TagProvenance[]> {
  return invoke<TagProvenance[]>("get_tag_provenance", { trackId });
}

/**
 * Save edits to N tracks as ONE journal transaction (`otori undo <tx>`
 * reverts the whole batch). Values land human-sourced, born curated.
 * Returns the tx id, or null when nothing actually changed.
 */
export function setTags(paths: string[], changes: FieldChange[]): Promise<number | null> {
  return invoke<number | null>("set_tags", { paths, changes });
}

export function getLyrics(path: string): Promise<LyricsDoc | null> {
  return invoke<LyricsDoc | null>("get_lyrics", { path });
}

/** Persist the per-track lyrics sync nudge (Stage `[`/`]` keys). */
export function setLyricsOffset(trackId: number, offsetMs: number): Promise<void> {
  return invoke<void>("set_lyrics_offset", { trackId, offsetMs });
}

/** Embedded cover art as a data URL, or null. */
export function getArtwork(path: string): Promise<string | null> {
  return invoke<string | null>("get_artwork", { path });
}

/**
 * Mirror playback state into the macOS status-bar (tray) menu:
 * `title` names the current track (null = nothing playing, transport
 * items disabled), `paused` picks the Play/Pause label.
 */
export function updateTray(title: string | null, paused: boolean): Promise<void> {
  return invoke<void>("update_tray", { title, paused });
}

export interface PendingTrack {
  id: number;
  path: string;
  /** false = BPM verdict already recorded; mix anchors only. */
  needs_bpm: boolean;
  hint_bpm: number | null;
  hint_bpm_max: number | null;
}

/** Tracks with analysis missing (index-side worklist for the sweeper). */
export function listAnalysisPending(): Promise<PendingTrack[]> {
  return invoke<PendingTrack[]>("list_analysis_pending");
}

/** What one Rust analysis pass wrote to the index (mirrors
    otori_analysis::PersistedVerdict). */
export interface PersistedVerdict {
  bpm: number | null;
  bpm_max: number | null;
  confidence: number | null;
  hint_applied: boolean;
  head: { bpm: number; beat_sec: number } | null;
  tail: { bpm: number; beat_sec: number } | null;
}

/** Analyze one pending track in Rust (decode + Beat This! + persist).
    Slow (~1s per minute of audio); rejects when the track is not
    pending. */
export function analyzeTrack(trackId: number): Promise<PersistedVerdict> {
  return invoke<PersistedVerdict>("analyze_track", { trackId });
}

/** Reopen analysis so the sweep re-verdicts. No args = whole library;
    `trackIds` = exactly those; `lowConfidence` = shaky + beatless.
    Returns the number of tracks reopened. */
export function reopenAnalysis(opts: {
  trackIds?: number[];
  lowConfidence?: number;
} = {}): Promise<number> {
  return invoke<number>("reopen_analysis", {
    trackIds: opts.trackIds ?? null,
    lowConfidence: opts.lowConfidence ?? null,
  });
}

/** Hold/release the display-sleep assertion (Stage mode playing). */
export function setDisplayAwake(awake: boolean): Promise<void> {
  return invoke<void>("set_display_awake", { awake });
}
