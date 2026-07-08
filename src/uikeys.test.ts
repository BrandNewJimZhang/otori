// Keyboard routing regression suite (audit P0): a focused button must
// keep native Enter/Space activation; inputs own everything but Escape;
// CapsLock must not disable the mode toggle.

import { describe, expect, it } from "vitest";
import { escapeIntent, routeKey, zoneOf, type KeyCombo } from "./uikeys";

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
    expect(routeKey(combo("ArrowDown"), "global")).toEqual({
      kind: "select-step",
      offset: 1,
      extend: false,
    });
    expect(routeKey(combo("ArrowUp"), "global")).toEqual({
      kind: "select-step",
      offset: -1,
      extend: false,
    });
    expect(routeKey(combo("Enter"), "global")).toEqual({ kind: "play-selected" });
    expect(routeKey(combo("Escape"), "global")).toEqual({ kind: "escape" });
  });

  it("toggles mode with CapsLock on (audit P3: uppercase S)", () => {
    expect(routeKey(combo("S"), "global")).toEqual({ kind: "toggle-mode" });
  });

  it("shift-arrows extend the selection (audit P1)", () => {
    expect(routeKey(combo("ArrowDown", { shift: true }), "global")).toEqual({
      kind: "select-step",
      offset: 1,
      extend: true,
    });
  });

  it("Home/End/PageUp/PageDown navigate the table (audit P1)", () => {
    expect(routeKey(combo("Home"), "global")).toEqual({ kind: "select-edge", edge: "first" });
    expect(routeKey(combo("End"), "global")).toEqual({ kind: "select-edge", edge: "last" });
    expect(routeKey(combo("PageDown"), "global")).toEqual({ kind: "select-page", offset: 1 });
    expect(routeKey(combo("PageUp"), "global")).toEqual({ kind: "select-page", offset: -1 });
  });

  it("printable characters feed type-ahead (audit P1)", () => {
    expect(routeKey(combo("b"), "global")).toEqual({ kind: "type-ahead", char: "b" });
    expect(routeKey(combo("S", { shift: true }), "global")).toEqual({
      kind: "type-ahead",
      char: "S",
    });
  });

  it("⌘I toggles the inspector (mac Get Info), except inside inputs", () => {
    expect(routeKey(combo("i", { meta: true }), "global")).toEqual({ kind: "toggle-inspector" });
    expect(routeKey(combo("i", { meta: true }), "input")).toEqual({ kind: "native" });
    // Stage has no inspector — the chord must go inert, not toggle
    // hidden Backstage state.
    expect(routeKey(combo("i", { meta: true }), "global", "stage")).toEqual({ kind: "native" });
  });

  it("plain i still feeds type-ahead", () => {
    expect(routeKey(combo("i"), "global")).toEqual({ kind: "type-ahead", char: "i" });
  });

  it("⌘A selects all visible rows (audit P1)", () => {
    expect(routeKey(combo("a", { meta: true }), "global")).toEqual({ kind: "select-all" });
    expect(routeKey(combo("a", { meta: true }), "input")).toEqual({ kind: "native" });
  });

  it("nudges the seek position with ←/→ (audit P1)", () => {
    expect(routeKey(combo("ArrowRight"), "global")).toEqual({ kind: "seek-nudge", secs: 5 });
    expect(routeKey(combo("ArrowLeft"), "global")).toEqual({ kind: "seek-nudge", secs: -5 });
  });

  it("? opens the shortcuts overlay (audit r5 P2), not type-ahead", () => {
    expect(routeKey(combo("?", { shift: true }), "global")).toEqual({ kind: "show-shortcuts" });
    expect(routeKey(combo("?"), "global")).toEqual({ kind: "show-shortcuts" });
    expect(routeKey(combo("?"), "input")).toEqual({ kind: "native" });
  });

  it("⌘, opens settings from every zone (macOS preferences chord)", () => {
    for (const zone of ["global", "input", "button", "slider"] as const) {
      expect(routeKey(combo(",", { meta: true }), zone)).toEqual({ kind: "show-settings" });
    }
    // Settings is app-level chrome, not a table surface — it must stay
    // reachable from Stage.
    expect(routeKey(combo(",", { meta: true }), "global", "stage")).toEqual({
      kind: "show-settings",
    });
    // Plain comma stays type-ahead.
    expect(routeKey(combo(","), "global")).toEqual({ kind: "type-ahead", char: "," });
  });

  it("passes non-printable keys and unmapped ⌘-chords through", () => {
    expect(routeKey(combo("F5"), "global")).toEqual({ kind: "native" });
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

describe("routeKey — stage surface (audit R4: hidden-table bleed-through)", () => {
  it("inert for table-selection keys — the table is not on screen", () => {
    // Enter used to play whatever row was invisibly selected in
    // Backstage: a surprise track change mid-performance.
    expect(routeKey(combo("Enter"), "global", "stage")).toEqual({ kind: "native" });
    expect(routeKey(combo("ArrowDown"), "global", "stage")).toEqual({ kind: "native" });
    expect(routeKey(combo("ArrowUp"), "global", "stage")).toEqual({ kind: "native" });
    expect(routeKey(combo("Home"), "global", "stage")).toEqual({ kind: "native" });
    expect(routeKey(combo("End"), "global", "stage")).toEqual({ kind: "native" });
    expect(routeKey(combo("PageDown"), "global", "stage")).toEqual({ kind: "native" });
    expect(routeKey(combo("b"), "global", "stage")).toEqual({ kind: "native" });
    expect(routeKey(combo("a", { meta: true }), "global", "stage")).toEqual({ kind: "native" });
    expect(routeKey(combo("f", { meta: true }), "global", "stage")).toEqual({ kind: "native" });
  });

  it("keeps the performance keys live", () => {
    expect(routeKey(combo(" "), "global", "stage")).toEqual({ kind: "toggle-pause" });
    expect(routeKey(combo("s"), "global", "stage")).toEqual({ kind: "toggle-mode" });
    expect(routeKey(combo("Escape"), "global", "stage")).toEqual({ kind: "escape" });
    expect(routeKey(combo("ArrowRight"), "global", "stage")).toEqual({
      kind: "seek-nudge",
      secs: 5,
    });
    expect(routeKey(combo("ArrowLeft"), "global", "stage")).toEqual({
      kind: "seek-nudge",
      secs: -5,
    });
    expect(routeKey(combo("ArrowRight", { meta: true }), "global", "stage")).toEqual({
      kind: "step-track",
      offset: 1,
    });
  });

  it("backstage surface is the default (existing call sites unchanged)", () => {
    expect(routeKey(combo("Enter"), "global")).toEqual({ kind: "play-selected" });
  });
});

describe("escapeIntent — Esc priority ladder (audit R4)", () => {
  it("always exits Stage, even with a stale Backstage selection", () => {
    // The stage hint promises "Esc → Backstage"; a selection left
    // behind in Backstage must not eat the first press.
    expect(escapeIntent("stage", true)).toBe("exit-stage");
    expect(escapeIntent("stage", false)).toBe("exit-stage");
  });

  it("clears a Backstage selection first", () => {
    expect(escapeIntent("backstage", true)).toBe("clear-selection");
  });

  it("is inert in Backstage with nothing selected", () => {
    expect(escapeIntent("backstage", false)).toBe("none");
  });
});

describe("zoneOf — keydown target classification", () => {
  it("classifies a textarea as input (lyrics editor: Space must type, not pause)", () => {
    expect(zoneOf({ tagName: "TEXTAREA" })).toBe("input");
  });

  it("classifies text inputs as input and range inputs as slider", () => {
    expect(zoneOf({ tagName: "INPUT", type: "text" })).toBe("input");
    expect(zoneOf({ tagName: "INPUT", type: "search" })).toBe("input");
    expect(zoneOf({ tagName: "INPUT", type: "range" })).toBe("slider");
  });

  it("classifies buttons as button", () => {
    expect(zoneOf({ tagName: "BUTTON" })).toBe("button");
  });

  it("everything else is global", () => {
    expect(zoneOf({ tagName: "DIV" })).toBe("global");
    expect(zoneOf(null)).toBe("global");
    expect(zoneOf(undefined)).toBe("global");
    expect(zoneOf({})).toBe("global");
  });
});

describe("routeKey — button zone (audit P0: focus fight)", () => {
  it("Enter and Space activate the button natively", () => {
    expect(routeKey(combo("Enter"), "button")).toEqual({ kind: "native" });
    expect(routeKey(combo(" "), "button")).toEqual({ kind: "native" });
  });

  it("non-activation keys stay global (arrows still move selection)", () => {
    expect(routeKey(combo("ArrowDown"), "button")).toEqual({
      kind: "select-step",
      offset: 1,
      extend: false,
    });
    expect(routeKey(combo("s"), "button")).toEqual({ kind: "toggle-mode" });
    expect(routeKey(combo("Escape"), "button")).toEqual({ kind: "escape" });
  });
});
