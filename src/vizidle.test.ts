// Visualizer idle policy: paused audio must not cost 60fps forever.
// Loops keep drawing while motion settles, then stop scheduling.

import { describe, expect, it } from "vitest";
import { shouldKeepDrawing } from "./vizidle";

describe("shouldKeepDrawing", () => {
  it("always draws while playing", () => {
    expect(shouldKeepDrawing(false, 0)).toBe(true);
    expect(shouldKeepDrawing(false, 0.5)).toBe(true);
  });

  it("keeps drawing while paused visuals still move", () => {
    expect(shouldKeepDrawing(true, 0.4)).toBe(true);
  });

  it("stops once paused visuals settle", () => {
    expect(shouldKeepDrawing(true, 0)).toBe(false);
    expect(shouldKeepDrawing(true, 0.0005)).toBe(false);
  });
});
