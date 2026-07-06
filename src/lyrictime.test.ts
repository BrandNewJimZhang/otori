// Lyric clock: the single mapping from engine position to lyric time.
// Everything that can skew perceived sync funnels through here: output
// latency (audio still in the pipeline), a perceptual lead (highlight
// reaction time), and the user's per-track offset.

import { describe, expect, it } from "vitest";
import { currentLineIndex, LYRIC_LEAD_MS, lyricClock, wordProgress } from "./lyrictime";
import type { LyricsDoc, LyricsWord } from "./types";

const doc = (times: number[]): LyricsDoc => ({
  kind: "line_synced",
  source: "sidecar",
  lines: times.map((t) => ({ time_ms: t, text: `line@${t}` })),
});

describe("currentLineIndex", () => {
  const d = doc([1000, 5000, 9000]);

  it("is -1 before the first line", () => {
    expect(currentLineIndex(d, 0)).toBe(-1);
    expect(currentLineIndex(d, 999)).toBe(-1);
  });

  it("picks the last line at or before the clock", () => {
    expect(currentLineIndex(d, 1000)).toBe(0); // exact boundary is active
    expect(currentLineIndex(d, 4999)).toBe(0);
    expect(currentLineIndex(d, 5000)).toBe(1);
    expect(currentLineIndex(d, 100000)).toBe(2);
  });
});

describe("lyricClock", () => {
  it("subtracts output latency: sound not yet heard must not light lines", () => {
    expect(lyricClock(10000, 200, 0)).toBe(10000 - 200 + LYRIC_LEAD_MS);
  });

  it("leads the position perceptually", () => {
    expect(lyricClock(10000, 0, 0)).toBe(10000 + LYRIC_LEAD_MS);
  });

  it("applies the track offset with core apply_offset semantics", () => {
    // Positive offset shifts lyric timestamps later (core's apply_offset
    // adds), which is equivalent to running the clock earlier.
    expect(lyricClock(10000, 0, 300)).toBe(10000 + LYRIC_LEAD_MS - 300);
    expect(lyricClock(10000, 0, -300)).toBe(10000 + LYRIC_LEAD_MS + 300);
  });
});

describe("wordProgress", () => {
  const words: LyricsWord[] = [
    { time_ms: 1000, text: "sha " },
    { time_ms: 2000, text: "la " },
    { time_ms: 3000, text: "la" },
  ];

  it("fills sung words fully, the current one partially, future ones not at all", () => {
    expect(wordProgress(words, 2500, 4000)).toEqual([1, 0.5, 0]);
  });

  it("is all-zero before the first word", () => {
    expect(wordProgress(words, 500, 4000)).toEqual([0, 0, 0]);
  });

  it("fills the last word against the line end", () => {
    expect(wordProgress(words, 3500, 4000)).toEqual([1, 1, 0.5]);
  });

  it("clamps a degenerate span to full once reached", () => {
    // Line end at (or before) the last word's start: no span to animate.
    expect(wordProgress(words, 3000, 3000)).toEqual([1, 1, 1]);
  });
});
