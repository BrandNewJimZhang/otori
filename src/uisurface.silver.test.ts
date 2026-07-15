// SILVER layer — eval-expansion round 4 (protocol: docs/design/
// eval-expansion-round1.md). UI-surface domain: keyboard routing
// (uikeys), status line (statusline), time/date formatting (format).
// Cases generated adversarially from the module contracts by a blind
// generator (no implementation, no existing tests in context), then
// adjudicated against the current implementations. Each case carries
// its derivation. Silver semantics: append-only for the model; a human
// may revoke any case (gold wins).
//
// Dedup record (exactly-covered assertions skipped, not re-asserted):
// - UK-1a/b (⌘F in input / dead in Stage) — uikeys.test "⌘F focuses
//   search from every zone" + the stage inert sweep. Only the ⌘⇧F
//   variant implemented below.
// - UK-2a–g (input keeps ⌘←/⌘I/⌘A, button activation, slider arrows,
//   slider Space/s stay global) — all in uikeys.test. Only Home on a
//   slider implemented below.
// - UK-3a–e,h (⌘, everywhere, ⌘←/→ steps, ⌘I, ⌘A, ⌘C native) — dup.
//   Only ⌘Space/⌘Enter implemented below.
// - UK-4a–e (null/undefined/DIV/{} → global, TEXTAREA → input,
//   text/search/range types) — uikeys.test zoneOf suite. Only the
//   typeless/checkbox/lowercase/SELECT probes below.
// - UK-5 (s / CapsLock-S / Shift+S / shifted "?") — uikeys.test covers
//   all four — dup, skipped.
// - UK-6a–j (stage inert sweep + surviving transport keys) — uikeys
//   .test stage suite. Only "?" in Stage implemented below.
// - UK-7 (escapeIntent ladder, all four cells) — dup, skipped.
// - UK-8 (scan outranks sweep, "No tracks", grouping, partial stats)
//   — statusline.test — dup, skipped.
// - UK-9b (null ETA / omitted model / null artist dropping segments)
//   — dup; the full four-segment line and remaining-0 are new below.
// - UK-11e (9h 16m) — statusline.test — dup, skipped.
// - UK-12a–e,h (null/NaN/±Infinity placeholder, 3600 rollover, m:ss
//   padding) — format.test — dup; -Infinity rides the same
//   !Number.isFinite gate as Infinity.
// - UK-13a–e (UTC→local day shift, null/garbage/"" placeholders) —
//   format.test — dup, skipped.
// - UK-14a/c/d (local rendering shape, null, garbage) — dup; only the
//   coupled date+time shift implemented below.

import { describe, expect, it } from "vitest";
import { routeKey, zoneOf, type KeyCombo } from "./uikeys";
import { statusLine } from "./statusline";
import { formatDateTime, formatTime } from "./format";
import { formatEta } from "./statusline";

const combo = (key: string, mods: Partial<KeyCombo> = {}): KeyCombo => ({
  key,
  meta: false,
  shift: false,
  ...mods,
});

describe("silver: chord matching edges (UK-1c, UK-3f/g)", () => {
  // Derivation: the ⌘F match is shift-insensitive — ⌘⇧F lands on
  // focus-search too, not on the "other ⌘-chords are the system's"
  // fallthrough. Locked: no macOS system chord competes for ⌘⇧F here.
  it("⌘⇧F still focuses search (shift-insensitive chord match)", () => {
    expect(routeKey(combo("F", { meta: true, shift: true }), "global")).toEqual({
      kind: "focus-search",
    });
  });

  // Derivation: meta is checked before the bare-key table — ⌘Space and
  // ⌘Enter are unclaimed chords and must fall to the system, never
  // fire play/pause or play-selected (invariant: no meta bleed-through).
  it("⌘Space and ⌘Enter are the system's, not transport keys", () => {
    expect(routeKey(combo(" ", { meta: true }), "global")).toEqual({ kind: "native" });
    expect(routeKey(combo("Enter", { meta: true }), "global")).toEqual({ kind: "native" });
  });
});

describe("silver: zoneOf duck-typing probes (UK-4f/h/i/j)", () => {
  // Derivation: an INPUT with no type attribute renders as a text
  // field — it must classify as "input" so typing stays typing.
  it("a typeless INPUT is an input", () => {
    expect(zoneOf({ tagName: "INPUT" })).toBe("input");
  });

  // Derivation: a checkbox INPUT classifies as "input" — its
  // activation keys (Space) stay native either way; the input zone is
  // the safe bucket for every non-range INPUT subtype.
  it("a checkbox INPUT is an input (activation stays native)", () => {
    expect(zoneOf({ tagName: "INPUT", type: "checkbox" })).toBe("input");
  });

  // Derivation: the duck-type compares tagName strictly — DOM tagName
  // is canonically uppercase for HTML elements, so lowercase input
  // (foreign/XML content) falls to global. Deliberate strictness of
  // the pure table, locked as a tripwire.
  it("a lowercase tagName is not recognized (HTML tagName is uppercase)", () => {
    expect(zoneOf({ tagName: "input", type: "text" })).toBe("global");
  });

  // RED-CANDIDATE (UK-4j): a focused SELECT classifies "global", so
  // its arrow keys would route to select-step (and get preventDefault-
  // ed away from the dropdown). Reachability: the app renders no
  // <select> today (grep-verified), so the hole is latent — same
  // class as r3 PU-11 (no production call site). If a native select
  // ever ships, this locked rendering doubles as the tripwire.
  // Asserting ACTUAL behavior; gold may revoke.
  it("SELECT is unrecognized → global (latent arrow-key hole — flagged)", () => {
    expect(zoneOf({ tagName: "SELECT" })).toBe("global");
  });
});

describe("silver: slider zone beyond the arrow carve-out (UK-2h)", () => {
  // RED-CANDIDATE (UK-2h): a native range input also supports Home/End
  // (jump to min/max), but the carve-out is arrows-only — Home on a
  // focused slider routes to select-edge, stealing the native jump.
  // Reachability: REAL — the player bar's volume/seek sliders are
  // focusable today. Preference call: extend the carve-out to
  // Home/End, or keep table navigation reachable from slider focus.
  // Asserting ACTUAL behavior; gold may rule either way.
  it("Home/End on a focused slider go to the table (native jump stolen — flagged)", () => {
    expect(routeKey(combo("Home"), "slider")).toEqual({ kind: "select-edge", edge: "first" });
    expect(routeKey(combo("End"), "slider")).toEqual({ kind: "select-edge", edge: "last" });
  });
});

describe("silver: Stage chrome survivors (UK-6k)", () => {
  // Derivation: show-shortcuts is not in the table-action set — the
  // overlay is app chrome and stays reachable mid-performance, like
  // ⌘, settings. Locked: "?" works in Stage.
  it("? opens the shortcuts overlay from Stage", () => {
    expect(routeKey(combo("?", { shift: true }), "global", "stage")).toEqual({
      kind: "show-shortcuts",
    });
  });
});

describe("silver: sweep line composition (UK-9a/c, UK-10a/b)", () => {
  const idle = { tracks: 1234, analyzed: 1200, scanning: false };

  // Derivation: all four segments compose in contract order —
  // model-labelled head, count, ETA, title—artist.
  it("composes the full four-segment line with a model label", () => {
    expect(
      statusLine({
        ...idle,
        sweep: { remaining: 12, etaMs: 42 * 60 * 1000 },
        currentTitle: "Boléro",
        currentArtist: "Ravel",
        modelLabel: "Standard",
      }),
    ).toBe("Analyzing (Standard) · 12 left · ~42m · Boléro — Ravel");
  });

  // Derivation: sweep non-null means running — the 0-remaining tail
  // instant must not collapse to stats or an empty line.
  it("remaining 0 is still a sweep line", () => {
    expect(statusLine({ ...idle, sweep: { remaining: 0, etaMs: null }, currentTitle: null, currentArtist: null }))
      .toBe("Analyzing · 0 left");
  });

  // Derivation: the artist hangs off the title segment — a title-less
  // artist must vanish entirely, never render as an orphan " — Ravel".
  it("an artist without a title never appears", () => {
    const line = statusLine({ ...idle, sweep: { remaining: 3, etaMs: null }, currentTitle: null, currentArtist: "Ravel" });
    expect(line).toBe("Analyzing · 3 left");
    expect(line).not.toContain("Ravel");
  });

  // Derivation: the ETA gate is `!= null`, not truthiness — a 0ms ETA
  // (sweep about to finish) renders "~0m" instead of vanishing.
  it("a zero ETA renders, discriminating != null from truthiness", () => {
    expect(statusLine({ ...idle, sweep: { remaining: 3, etaMs: 0 }, currentTitle: null, currentArtist: null }))
      .toBe("Analyzing · 3 left · ~0m");
  });
});

describe("silver: formatEta hour-boundary cliffs (UK-11a–d/f)", () => {
  // Derivation: "bare minutes under an hour, hours + minutes past it"
  // — rounding happens BEFORE the branch, so 59.6 rounded minutes
  // crosses into the hour form; "~60m" can never render.
  it("rounds first, then branches: no ~60m form exists", () => {
    expect(formatEta(0)).toBe("~0m");
    expect(formatEta(59.4 * 60 * 1000)).toBe("~59m");
    expect(formatEta(59.6 * 60 * 1000)).toBe("~1h 0m");
    expect(formatEta(60 * 60 * 1000)).toBe("~1h 0m");
  });

  // RED-CANDIDATE (UK-11f): a negative ETA renders "~-1m" — a minus
  // sign in the ambient line. Reachability: etaMs derives from a
  // rolling mean of positive per-track durations times a non-negative
  // remaining count, so a negative value requires a code bug upstream
  // — same class as r3 PU-2. Asserting ACTUAL behavior; gold may
  // revoke (clamp to ~0m would be the fix shape).
  it("negative ETA leaks a minus sign (corrupt input — flagged)", () => {
    expect(formatEta(-60 * 1000)).toBe("~-1m");
  });
});

describe("silver: statusLine analyzed overcount (UK-11g)", () => {
  // Derivation: the full-coverage branch is >=, not == — an analyzed
  // count exceeding tracks (verdicts for since-deleted rows) reads as
  // fully analyzed instead of leaking "1,300 analyzed" over 1,234.
  it("an overcount reads as fully analyzed", () => {
    expect(statusLine({ tracks: 1234, analyzed: 1300, scanning: false, sweep: null, currentTitle: null, currentArtist: null }))
      .toBe("1,234 tracks");
  });
});

describe("silver: formatTime flooring and edges (UK-12f/g/i)", () => {
  // Derivation: seconds floor — 59.999 is "0:59", never rounds to the
  // illegal "0:60"; 3599 is the largest m:ss value, no phantom hour.
  it("floors sub-second parts and caps m:ss at 59:59", () => {
    expect(formatTime(59.999)).toBe("0:59");
    expect(formatTime(3599)).toBe("59:59");
  });

  // RED-CANDIDATE (UK-12i): -5 is finite, so the placeholder gate
  // passes it and the digits go negative: "-1:-5" — garbage text in a
  // time cell. Reachability: durations come from the index and
  // positions from the audio element, both non-negative; PlayerBar
  // already clamps its remaining-time subtraction. Same class as r3
  // PU-2 (corrupt negatives don't occur). Asserting ACTUAL behavior;
  // gold may revoke.
  it("negative seconds render garbage digits (corrupt input — flagged)", () => {
    expect(formatTime(-5)).toBe("-1:-5");
  });
});

describe("silver: date parsing strictness (UK-13f, UK-14b)", () => {
  // Derivation: the parser is strictly SQLite-shaped ("YYYY-MM-DD
  // HH:MM:SS" + implied UTC) — an ISO 8601 stamp is out-of-contract
  // and hits the placeholder, locking that no second input format
  // creeps in silently.
  it("an ISO 8601 stamp is out-of-contract garbage", () => {
    expect(formatDateTime("2026-07-15T12:00:00Z")).toBe("—");
  });

  // Derivation: date and time must shift together across the local
  // day boundary — a split implementation that converts only the time
  // would pair the UTC date with the local clock.
  it("date and time shift together across the day boundary", () => {
    const d = new Date(Date.UTC(2026, 6, 16, 1, 5));
    const p = (n: number) => String(n).padStart(2, "0");
    const expected = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    expect(formatDateTime("2026-07-16 01:05:00")).toBe(expected);
  });
});
