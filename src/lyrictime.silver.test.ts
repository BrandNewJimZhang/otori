// SILVER layer — eval-expansion round 1 (docs/design/
// eval-expansion-round1.md). Cases generated adversarially from the
// lyric-clock contract by a blind generator, adjudicated green against
// the current implementation. Derivations inline; silver semantics as
// in playorder.silver.test.ts.

import { describe, expect, it } from "vitest";
import { currentLineIndex, lyricClock, wordProgress } from "./lyrictime";
import type { LyricsDoc } from "./types";

const doc = (times: number[]): LyricsDoc => ({
  kind: "line_synced",
  source: "embedded",
  lines: times.map((t) => ({ time_ms: t, text: "", words: [] })),
});

const words = (times: number[]) => times.map((t) => ({ time_ms: t, text: "x" }));

describe("silver: skew composition (LC-1/2/11)", () => {
  // Derivation: each skew has a physical meaning; wrong signs cancel
  // or double. Bluetooth latency + user nudge must compose, not fight.
  it("stacks Bluetooth latency and a positive nudge additively", () => {
    // 10000 - 400 + 80 - 200: a wrong offset sign yields 9880 and the
    // highlight runs ~400ms early — instantly felt by users who know
    // their songs by heart.
    expect(lyricClock(10000, 400, 200)).toBe(9480);
  });

  it("lets a negative nudge exactly cancel output latency", () => {
    // The user compensating 400ms of latency by hand must land on the
    // zero-latency clock, not double the compensation.
    expect(lyricClock(5000, 400, -400)).toBe(lyricClock(5000, 0, 0));
  });

  it("a positive nudge delays the wall-clock instant a line lights by that amount", () => {
    // LRC [offset:] convention end-to-end: line at 10000 lights when
    // clock reaches it; +500 offset moves that positionMs 500 later.
    const lightsAt = (offsetMs: number) => {
      // smallest positionMs with clock >= 10000
      return 10000 - 80 + offsetMs;
    };
    expect(lyricClock(lightsAt(0), 0, 0)).toBe(10000);
    expect(lyricClock(lightsAt(500), 0, 500)).toBe(10000);
    expect(lyricClock(lightsAt(500) - 1, 0, 500)).toBeLessThan(10000);
  });
});

describe("silver: clock extremes (LC-3/12)", () => {
  // Derivation: "nothing lights before the singer starts" at the left
  // extreme; index saturation at the right extreme.
  it("goes negative at song start under Bluetooth latency, lighting nothing", () => {
    const clock = lyricClock(0, 500, 0);
    expect(clock).toBe(-420); // not clamped: clamping would light line 0 early
    expect(currentLineIndex(doc([0, 5000]), clock)).toBe(-1);
  });

  it("saturates at the last line long after the song ends", () => {
    expect(currentLineIndex(doc([0, 5000]), 1e9)).toBe(1);
  });
});

describe("silver: exact line-boundary instants (LC-4)", () => {
  // Derivation: "at or before" must include the instant itself — a
  // strict-less-than makes every line late by one tick.
  it("lights a line at exactly its own timestamp", () => {
    const d = doc([1000, 2000, 3000]);
    expect(currentLineIndex(d, 999)).toBe(-1);
    expect(currentLineIndex(d, 1000)).toBe(0);
    expect(currentLineIndex(d, 2000)).toBe(1);
  });
});

describe("silver: duplicate line timestamps (LC-5)", () => {
  // Derivation: wild LRC has duplicate timestamps; "last at or before"
  // must resolve to the LAST duplicate and never step backwards.
  it("resolves to the last of the duplicates, monotonically", () => {
    const d = doc([1000, 3000, 3000, 4000]);
    expect(currentLineIndex(d, 2999)).toBe(0);
    expect(currentLineIndex(d, 3000)).toBe(2);
    expect(currentLineIndex(d, 3001)).toBe(2);
    expect(currentLineIndex(d, 4000)).toBe(3);
  });
});

describe("silver: degenerate documents (LC-6)", () => {
  // Derivation: malformed/instrumental LRC must not crash or light
  // anything — empty is a state, not an error, for a lyrics display.
  it("returns -1 for an empty document", () => {
    expect(currentLineIndex(doc([]), 5000)).toBe(-1);
  });

  it("returns an empty fill array for an empty word list", () => {
    expect(wordProgress([], 5000, 9999)).toEqual([]);
  });
});

describe("silver: zero-span word chains (LC-7)", () => {
  // Derivation: all words on one timestamp (wild LRC) — degenerate
  // spans snap to full at their instant, no 0/0 NaN, and the fills
  // stay non-increasing left to right.
  it("snaps the zero-span words and fills the real one continuously", () => {
    const w = words([5000, 5000, 5000]);
    expect(wordProgress(w, 4999, 6000)).toEqual([0, 0, 0]);
    expect(wordProgress(w, 5000, 6000)).toEqual([1, 1, 0]);
    expect(wordProgress(w, 5500, 6000)).toEqual([1, 1, 0.5]);
    expect(wordProgress(w, 6000, 6000)).toEqual([1, 1, 1]);
  });
});

describe("silver: exact word-boundary handoff (LC-10)", () => {
  // Derivation: at a word's own time_ms the fill is exactly starting
  // (0); at its span end exactly 1 — the wipe hands off with no
  // overlap and no gap.
  it("hands off from word to word with no overlap at the shared instant", () => {
    const w = words([1000, 2000]);
    expect(wordProgress(w, 1000, 3000)).toEqual([0, 0]);
    expect(wordProgress(w, 1500, 3000)).toEqual([0.5, 0]);
    expect(wordProgress(w, 2000, 3000)).toEqual([1, 0]);
  });
});
