// Keyboard routing regression suite (audit P0): a focused button must
// keep native Enter/Space activation; inputs own everything but Escape;
// CapsLock must not disable the mode toggle.

import { describe, expect, it } from "vitest";
import { routeKey, type KeyCombo } from "./uikeys";

const combo = (key: string, mods: Partial<KeyCombo> = {}): KeyCombo => ({
  key,
  meta: false,
  shift: false,
  ...mods,
});

describe("routeKey — global zone", () => {
  it("maps the app keys", () => {
    expect(routeKey(combo("s"), "global")).toEqual({ kind: "toggle-mode" });
    expect(routeKey(combo(" "), "global")).toEqual({ kind: "toggle-pause" });
    expect(routeKey(combo("ArrowDown"), "global")).toEqual({ kind: "select-step", offset: 1 });
    expect(routeKey(combo("ArrowUp"), "global")).toEqual({ kind: "select-step", offset: -1 });
    expect(routeKey(combo("Enter"), "global")).toEqual({ kind: "play-selected" });
    expect(routeKey(combo("Escape"), "global")).toEqual({ kind: "escape" });
  });

  it("toggles mode with CapsLock on (audit P3: uppercase S)", () => {
    expect(routeKey(combo("S"), "global")).toEqual({ kind: "toggle-mode" });
  });

  it("nudges the seek position with ←/→ (audit P1)", () => {
    expect(routeKey(combo("ArrowRight"), "global")).toEqual({ kind: "seek-nudge", secs: 5 });
    expect(routeKey(combo("ArrowLeft"), "global")).toEqual({ kind: "seek-nudge", secs: -5 });
  });

  it("passes unknown keys and unmapped ⌘-chords through", () => {
    expect(routeKey(combo("x"), "global")).toEqual({ kind: "native" });
    expect(routeKey(combo("c", { meta: true }), "global")).toEqual({ kind: "native" });
  });

  it("⌘←/→ steps tracks (audit P1), except inside inputs (line nav)", () => {
    expect(routeKey(combo("ArrowRight", { meta: true }), "global")).toEqual({
      kind: "step-track",
      offset: 1,
    });
    expect(routeKey(combo("ArrowLeft", { meta: true }), "button")).toEqual({
      kind: "step-track",
      offset: -1,
    });
    expect(routeKey(combo("ArrowRight", { meta: true }), "input")).toEqual({ kind: "native" });
  });
});

describe("routeKey — search shortcut", () => {
  it("⌘F focuses search from every zone", () => {
    for (const zone of ["global", "input", "button"] as const) {
      expect(routeKey(combo("f", { meta: true }), zone)).toEqual({ kind: "focus-search" });
    }
  });
});

describe("routeKey — input zone", () => {
  it("Escape blurs; everything else is the input's", () => {
    expect(routeKey(combo("Escape"), "input")).toEqual({ kind: "blur-input" });
    expect(routeKey(combo(" "), "input")).toEqual({ kind: "native" });
    expect(routeKey(combo("s"), "input")).toEqual({ kind: "native" });
    expect(routeKey(combo("Enter"), "input")).toEqual({ kind: "native" });
  });
});

describe("routeKey — slider zone", () => {
  it("keeps native arrow nudging on a focused range input", () => {
    expect(routeKey(combo("ArrowLeft"), "slider")).toEqual({ kind: "native" });
    expect(routeKey(combo("ArrowRight"), "slider")).toEqual({ kind: "native" });
    expect(routeKey(combo("ArrowUp"), "slider")).toEqual({ kind: "native" });
  });

  it("space and s stay global", () => {
    expect(routeKey(combo(" "), "slider")).toEqual({ kind: "toggle-pause" });
    expect(routeKey(combo("s"), "slider")).toEqual({ kind: "toggle-mode" });
  });
});

describe("routeKey — button zone (audit P0: focus fight)", () => {
  it("Enter and Space activate the button natively", () => {
    expect(routeKey(combo("Enter"), "button")).toEqual({ kind: "native" });
    expect(routeKey(combo(" "), "button")).toEqual({ kind: "native" });
  });

  it("non-activation keys stay global (arrows still move selection)", () => {
    expect(routeKey(combo("ArrowDown"), "button")).toEqual({ kind: "select-step", offset: 1 });
    expect(routeKey(combo("s"), "button")).toEqual({ kind: "toggle-mode" });
    expect(routeKey(combo("Escape"), "button")).toEqual({ kind: "escape" });
  });
});
