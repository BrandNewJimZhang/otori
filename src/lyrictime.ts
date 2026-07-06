// Lyric clock (SSOT): the one mapping from engine position to the
// clock lyric timestamps are compared against. Three skews funnel in:
//
//   outputLatencyMs  — audio already sent to the graph but not yet
//                      heard (AudioContext output+base latency; hundreds
//                      of ms on Bluetooth). Subtracted: don't light a
//                      line the ear hasn't reached.
//   LYRIC_LEAD_MS    — perceptual lead. A highlight that lands exactly
//                      on the syllable reads as late (visual reaction
//                      time), so the clock runs slightly ahead.
//   trackOffsetMs    — the user's per-track nudge, same sign convention
//                      as core's apply_offset / LRC [offset:]: positive
//                      shifts lyric timestamps later, so it subtracts
//                      from the clock.

import type { LyricsDoc, LyricsWord } from "./types";

/** Perceptual lead: highlight slightly before the syllable is heard. */
export const LYRIC_LEAD_MS = 80;

/** Position → lyric clock. Compare lyric time_ms against this value. */
export function lyricClock(
  positionMs: number,
  outputLatencyMs: number,
  trackOffsetMs: number,
): number {
  return positionMs - outputLatencyMs + LYRIC_LEAD_MS - trackOffsetMs;
}

/** Index of the last line at or before `clockMs`; -1 before the first. */
export function currentLineIndex(doc: LyricsDoc, clockMs: number): number {
  let idx = -1;
  for (let i = 0; i < doc.lines.length; i++) {
    if (doc.lines[i].time_ms <= clockMs) idx = i;
    else break;
  }
  return idx;
}

/**
 * Per-word fill 0..1 for the karaoke wipe: 1 = sung, 0 = upcoming, and
 * the current word fills continuously across its span (next word's
 * start, or `lineEndMs` for the last word). A degenerate span (zero or
 * negative) snaps to full once the word's time is reached.
 */
export function wordProgress(
  words: LyricsWord[],
  clockMs: number,
  lineEndMs: number,
): number[] {
  return words.map((w, i) => {
    if (clockMs < w.time_ms) return 0;
    const end = i + 1 < words.length ? words[i + 1].time_ms : lineEndMs;
    if (end <= w.time_ms) return 1;
    return Math.min(1, (clockMs - w.time_ms) / (end - w.time_ms));
  });
}
