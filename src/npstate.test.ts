// np-state event contract: the mini panel renders exactly what the
// main window broadcasts — idle vs playing must be unambiguous, and
// non-finite durations must not leak into the payload.

import { describe, expect, it } from "vitest";
import { buildNpState } from "./npstate";
import type { TrackRow } from "./types";

function track(over: Partial<TrackRow> = {}): TrackRow {
  return {
    id: 1,
    path: "/music/Artist/song.flac",
    format: "flac",
    duration_secs: 203,
    replaygain_db: null,
    bpm: null,
    bpm_max: null,
    bpm_confidence: null,
    bpm_hint: null,
    mix_head_bpm: null,
    mix_head_beat_sec: null,
    mix_tail_bpm: null,
    mix_tail_beat_sec: null,
    mix_analyzed: false,
    lyrics_offset_ms: 0,
    title: "Song",
    artist: "Artist",
    album: null,
    ...over,
  };
}

describe("buildNpState", () => {
  it("mirrors the playing track", () => {
    expect(buildNpState(track(), false, "data:image/png;base64,x", 203.5)).toEqual({
      title: "Song",
      artist: "Artist",
      paused: false,
      artwork: "data:image/png;base64,x",
      durationSecs: 203.5,
    });
  });

  it("falls back to the filename when the title tag is missing", () => {
    expect(buildNpState(track({ title: null }), true, null, 10).title).toBe("song.flac");
  });

  it("is fully idle when nothing is playing (paused forced true)", () => {
    expect(buildNpState(null, false, "stale-art", 42)).toEqual({
      title: null,
      artist: null,
      paused: true,
      artwork: null,
      durationSecs: null,
    });
  });

  it("nulls a duration the engine has not loaded yet (NaN/∞)", () => {
    expect(buildNpState(track(), false, null, NaN).durationSecs).toBeNull();
    expect(buildNpState(track(), false, null, Infinity).durationSecs).toBeNull();
  });
});
