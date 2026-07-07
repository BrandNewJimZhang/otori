// Status bar line composition: ambient background state, lowest visual
// priority in the window. Pure — the component just renders whatever
// this returns.

import { describe, expect, it } from "vitest";
import { statusLine } from "./statusline";

const idle = { tracks: 1234, analyzed: 1200, scanning: false };

describe("statusLine", () => {
  it("shows library stats when idle", () => {
    expect(statusLine({ ...idle, sweep: null, currentTitle: null, currentArtist: null }))
      .toBe("1,234 tracks · 1,200 analyzed");
  });

  it("shows full analysis coverage without the redundant count", () => {
    expect(statusLine({ tracks: 500, analyzed: 500, scanning: false, sweep: null, currentTitle: null, currentArtist: null }))
      .toBe("500 tracks");
  });

  it("empty library says so", () => {
    expect(statusLine({ tracks: 0, analyzed: 0, scanning: false, sweep: null, currentTitle: null, currentArtist: null }))
      .toBe("No tracks");
  });

  it("sweep progress takes over while analyzing", () => {
    expect(statusLine({ ...idle, sweep: { remaining: 834, etaMs: null }, currentTitle: null, currentArtist: null }))
      .toBe("Analyzing · 834 left");
  });

  it("appends ETA once the sweep has samples", () => {
    // 9h 16m in ms.
    const etaMs = (9 * 3600 + 16 * 60) * 1000;
    expect(statusLine({ ...idle, sweep: { remaining: 834, etaMs }, currentTitle: null, currentArtist: null }))
      .toBe("Analyzing · 834 left · ~9h 16m");
  });

  it("formats sub-hour ETA as minutes", () => {
    expect(statusLine({ ...idle, sweep: { remaining: 40, etaMs: 42 * 60 * 1000 }, currentTitle: null, currentArtist: null }))
      .toBe("Analyzing · 40 left · ~42m");
  });

  it("appends the current track title — artist", () => {
    expect(statusLine({ ...idle, sweep: { remaining: 834, etaMs: null }, currentTitle: "Galaxy", currentArtist: "M2U" }))
      .toBe("Analyzing · 834 left · Galaxy — M2U");
  });

  it("omits the artist when there is none", () => {
    expect(statusLine({ ...idle, sweep: { remaining: 834, etaMs: null }, currentTitle: "track.flac", currentArtist: null }))
      .toBe("Analyzing · 834 left · track.flac");
  });

  it("composes count, ETA, and current track together", () => {
    const etaMs = (2 * 3600 + 5 * 60) * 1000;
    expect(statusLine({ ...idle, sweep: { remaining: 700, etaMs }, currentTitle: "Galaxy", currentArtist: "M2U" }))
      .toBe("Analyzing · 700 left · ~2h 5m · Galaxy — M2U");
  });

  it("scanning outranks everything (rows are still arriving)", () => {
    expect(statusLine({ tracks: 10, analyzed: 3, scanning: true, sweep: { remaining: 7, etaMs: null }, currentTitle: "X", currentArtist: null }))
      .toBe("Scanning…");
  });

  it("last sweep item reads singular", () => {
    expect(statusLine({ ...idle, sweep: { remaining: 1, etaMs: null }, currentTitle: null, currentArtist: null }))
      .toBe("Analyzing · 1 left");
  });

  it("names the active model while a switch's re-sweep runs", () => {
    // A model switch reopens foreign-model verdicts; naming the model
    // in the line tells the user *which* engine is grinding, not just
    // that work is happening.
    expect(
      statusLine({ tracks: 10, analyzed: 3, scanning: false, sweep: { remaining: 7, etaMs: null }, currentTitle: null, currentArtist: null, modelLabel: "Standard" }),
    ).toBe("Analyzing (Standard) · 7 left");
  });

  it("omits the model label when not provided (back-compat)", () => {
    expect(statusLine({ tracks: 10, analyzed: 3, scanning: false, sweep: { remaining: 7, etaMs: null }, currentTitle: null, currentArtist: null }))
      .toBe("Analyzing · 7 left");
  });
});
