// Status bar line composition: ambient background state, lowest
// visual priority in the window. Pure — the component just renders
// whatever this returns.

import { describe, expect, it } from "vitest";
import { statusLine } from "./statusline";

describe("statusLine", () => {
  it("shows library stats when idle", () => {
    expect(statusLine({ tracks: 1234, analyzed: 1200, scanning: false, sweepRemaining: null }))
      .toBe("1,234 tracks · 1,200 analyzed");
  });

  it("shows full analysis coverage without the redundant count", () => {
    expect(statusLine({ tracks: 500, analyzed: 500, scanning: false, sweepRemaining: null }))
      .toBe("500 tracks");
  });

  it("empty library says so", () => {
    expect(statusLine({ tracks: 0, analyzed: 0, scanning: false, sweepRemaining: null }))
      .toBe("No tracks");
  });

  it("sweep progress takes over while analyzing", () => {
    expect(statusLine({ tracks: 1234, analyzed: 400, scanning: false, sweepRemaining: 834 }))
      .toBe("Analyzing · 834 left");
  });

  it("scanning outranks everything (rows are still arriving)", () => {
    expect(statusLine({ tracks: 10, analyzed: 3, scanning: true, sweepRemaining: 7 }))
      .toBe("Scanning…");
  });

  it("last sweep item reads singular", () => {
    expect(statusLine({ tracks: 10, analyzed: 9, scanning: false, sweepRemaining: 1 }))
      .toBe("Analyzing · 1 left");
  });
});
