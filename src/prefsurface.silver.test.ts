// SILVER layer — eval-expansion round 5 (protocol: docs/design/
// eval-expansion-round1.md). Preference-persistence domain: the ONE
// surface where corrupt input is production-reachable (old-version
// blobs, hand-edited localStorage). Cases generated adversarially from
// the prefs/settings contracts by a blind generator (no implementation,
// no existing tests in context), then adjudicated against the current
// implementations. Silver semantics: append-only for the model; a
// human may revoke any case (gold wins).
//
// Dedup record (exactly-covered assertions skipped, not re-asserted):
// - PR-1 (full round-trip) is prefs.test "round-trips every
//   preference" — dup, skipped.
// - PR-2 (missing blob → defaults) is prefs.test "returns defaults
//   when nothing is stored" — dup, skipped.
// - PR-3 (non-JSON blob) partial: "{not json" is prefs.test corrupt
//   case; the empty-string and bare-"undefined" variants are new.
// - PR-5 (old-version subset blob) is prefs.test "fills defaults for
//   fields missing from an older blob" — dup, skipped.
// - PR-10 partial: unknown hidden key is prefs.test "invalid
//   hidden-column entries"; non-hideable "title" is prefs.test "title
//   is never hideable". The MIXED array (one valid + one invalid
//   entry) below is the new surface.
// - PR-12 (unknown analysisModel degrades alone) is prefs.test "an
//   invalid analysis model falls back to small" — dup, skipped.
// - PR-13 partial: slider 0/1/2..max legs are settings.test; the
//   fractional 1.5 leg is new (asserted at actual below).
//
// Generator ambiguities resolved by the adjudicator without gold:
// - PR-7 (out-of-range volume: clamp vs reject): the suite's existing
//   corrupt case (volume 9 → DEFAULTS) already locks whole-blob
//   rejection for core fields — volume/sort/shuffle/repeat/theme are
//   the original v1 pref set validated as a unit; only later-arrival
//   fields degrade individually. Locked at actual, not escalated:
//   the boundary IS the v1/v2 seam, documented here.
// - PR-8 (negative crossfade → 0): clamp and default coincide at 0;
//   mechanism indistinguishable, value locked.

import { describe, expect, it } from "vitest";
import { loadPrefs, savePrefs, type Prefs } from "./prefs";
import { crossfadeFromSlider } from "./settings";

function storage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

function seeded(blob: string): Storage {
  const s = storage();
  s.setItem("otori.prefs", blob);
  return s;
}

const DEFAULTS: Prefs = {
  volume: 1,
  sort: null,
  shuffle: false,
  repeat: "off",
  theme: "dark",
  crossfadeSec: 0,
  density: "comfortable",
  columnWidths: {},
  hiddenColumns: [],
  analysisModel: "small",
};

describe("silver: non-object JSON blobs (PR-4)", () => {
  // Derivation: a blob that parses but isn't an object has no fields
  // to degrade individually — whole-blob fallback is the only path to
  // the promised "complete valid Prefs". Spreading an array/number
  // into defaults contributes nothing; the type gates then reject or
  // pass untouched defaults.
  it("array, null, number, and string blobs all yield full defaults", () => {
    for (const blob of ["[]", "null", "42", '"dark"']) {
      expect(loadPrefs(seeded(blob))).toEqual(DEFAULTS);
    }
  });

  // Derivation: PR-3's remaining legs — an empty string and the
  // literal "undefined" are both JSON.parse throws, same catch path
  // as "{not json".
  it("empty-string and bare-undefined blobs fall back to defaults", () => {
    expect(loadPrefs(seeded(""))).toEqual(DEFAULTS);
    expect(loadPrefs(seeded("undefined"))).toEqual(DEFAULTS);
  });
});

describe("silver: the v1/v2 degradation seam (PR-6)", () => {
  // Derivation: the adjudicator resolved the generator's per-field
  // hope against the implementation's actual policy — the original
  // v1 pref set (volume/sort/shuffle/repeat/theme) validates as a
  // unit (any bad member rejects the whole blob), while every
  // later-arrival field (crossfadeSec, density, columnWidths,
  // hiddenColumns, analysisModel) degrades individually. A corrupt
  // theme therefore drops the valid volume beside it; a corrupt
  // density does not. This asymmetry is the documented seam, not an
  // accident: v1 fields ship in every blob ever written, so their
  // corruption implies a hand-edit or foreign writer — distrust the
  // lot. Locked at actual.
  it("a corrupt v1 field (theme) rejects the whole blob", () => {
    const p = loadPrefs(seeded(JSON.stringify({ volume: 0.3, sort: null, theme: "solarized" })));
    expect(p).toEqual(DEFAULTS); // volume 0.3 is dropped too
  });

  it("a corrupt v2 field (density) degrades alone beside a kept volume", () => {
    const p = loadPrefs(seeded(JSON.stringify({ volume: 0.3, sort: null, density: "cozy" })));
    expect(p).toEqual({ ...DEFAULTS, volume: 0.3 });
  });
});

describe("silver: volume boundary values (PR-7)", () => {
  // Derivation: 0 (mute) and 1 (unity) are both legal endpoints; 0 is
  // the falsy trap — a truthiness gate would silently reset a muted
  // player to full volume on relaunch.
  it("volume 0 survives the round trip (falsy is not invalid)", () => {
    expect(loadPrefs(seeded(JSON.stringify({ volume: 0, sort: null }))).volume).toBe(0);
  });

  // Derivation: v1-unit rejection (see PR-6): out-of-range and
  // non-number volumes reject the blob wholesale.
  it("out-of-range and non-number volumes reject the blob", () => {
    for (const volume of [3.5, -0.2, "loud", null]) {
      expect(loadPrefs(seeded(JSON.stringify({ volume, sort: null })))).toEqual(DEFAULTS);
    }
  });
});

describe("silver: crossfadeSec ceiling (PR-8)", () => {
  // Derivation: the documented 30s ceiling is inclusive — 30 is a
  // legal stored value and must not be folded to 0 by an off-by-one
  // exclusive bound.
  it("exactly 30 survives; beyond and negative fall to 0, keeping the rest", () => {
    expect(loadPrefs(seeded(JSON.stringify({ volume: 0.7, sort: null, crossfadeSec: 30 }))))
      .toEqual({ ...DEFAULTS, volume: 0.7, crossfadeSec: 30 });
    expect(loadPrefs(seeded(JSON.stringify({ volume: 0.7, sort: null, crossfadeSec: -4 }))))
      .toEqual({ ...DEFAULTS, volume: 0.7 });
    expect(loadPrefs(seeded(JSON.stringify({ volume: 0.7, sort: null, crossfadeSec: "5" }))))
      .toEqual({ ...DEFAULTS, volume: 0.7 });
  });
});

describe("silver: sort validation shapes (PR-9)", () => {
  // Derivation: sort is a v1 field — a half-legal sort (good key, bad
  // dir) can't be repaired without guessing, and v1 corruption
  // rejects the blob (PR-6 seam). All four corrupt shapes land on
  // full defaults.
  it("unknown key, bad dir, and non-object sorts reject the blob", () => {
    for (const sort of [
      { key: "nonexistent", dir: 1 },
      { key: "title", dir: 0 },
      { key: "title", dir: "asc" },
      "title",
    ]) {
      expect(loadPrefs(seeded(JSON.stringify({ volume: 0.5, sort })))).toEqual(DEFAULTS);
    }
  });
});

describe("silver: mixed-validity collection fields (PR-10, PR-11)", () => {
  // Derivation: hiddenColumns validates all-or-nothing (Array.every
  // gate): one unknown entry degrades the WHOLE array to all-visible
  // rather than filtering item-wise. The valid "artist" hide is lost
  // alongside the corrupt entry. Locked at actual — the alternative
  // (per-item filter) was the generator's preference, but all-visible
  // is the safe direction (nothing hidden that shouldn't be) and the
  // field degrades alone, never poisoning the rest.
  it("one unknown entry degrades the whole hiddenColumns array", () => {
    const p = loadPrefs(
      seeded(JSON.stringify({ volume: 1, sort: null, hiddenColumns: ["artist", "nonexistent"] })),
    );
    expect(p.hiddenColumns).toEqual([]);
  });

  // Derivation: columnWidths uses the same all-or-nothing gate: one
  // zero/negative width drops the whole map back to auto layout.
  // Symmetric with hiddenColumns; locked at actual.
  it("one invalid width degrades the whole columnWidths map", () => {
    const p = loadPrefs(
      seeded(JSON.stringify({ volume: 1, sort: null, columnWidths: { title: 180, artist: 0 } })),
    );
    expect(p.columnWidths).toEqual({});
  });

  it("an all-valid width map survives untouched", () => {
    const p = loadPrefs(
      seeded(JSON.stringify({ volume: 1, sort: null, columnWidths: { title: 180, bpm: 64 } })),
    );
    expect(p.columnWidths).toEqual({ title: 180, bpm: 64 });
  });
});

describe("silver: savePrefs writes the canonical key (PR-1 remainder)", () => {
  // Derivation: the storage key "otori.prefs" is contract; a typo'd
  // key would silently orphan every saved preference.
  it("persists under otori.prefs as parseable JSON", () => {
    const s = storage();
    savePrefs(s, { ...DEFAULTS, volume: 0.42 });
    const raw = s.getItem("otori.prefs");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).volume).toBe(0.42);
  });
});

describe("silver: crossfadeFromSlider beyond the mapped points (PR-13, PR-14)", () => {
  // RED-CANDIDATE (PR-13f): the doc comment says "rounds 1 up to the
  // 2s floor so a tiny fade can't produce an inaudible half-
  // crossfade", but the implementation maps ONLY the exact value 1 —
  // 1.5 passes through as 1.5 seconds, inside the inaudible band the
  // comment promises to close. Reachability: both production sliders
  // step by 1 (PlayerBar step={1}, SettingsOverlay step={1}), so a
  // fractional value needs a programmatic setValue or a future finer
  // step. Asserting ACTUAL behavior; gold may revoke.
  it("1.5 passes through below the 2s floor (comment promises the floor — flagged)", () => {
    expect(crossfadeFromSlider(1.5)).toBe(1.5);
  });

  // RED-CANDIDATE (PR-14a): out-of-range slider values pass through
  // unclamped — 17 exceeds CROSSFADE_SLIDER_MAX and -1 emits a
  // negative crossfade second. Reachability: the two production call
  // sites feed range inputs bounded by min/max attributes, so
  // out-of-range needs a programmatic dispatch; loadPrefs's own 0..30
  // gate would keep a persisted 17 but reject -1 on next launch.
  // Asserting ACTUAL behavior; gold may revoke.
  it("out-of-range values pass through unclamped (flagged)", () => {
    expect(crossfadeFromSlider(17)).toBe(17);
    expect(crossfadeFromSlider(-1)).toBe(-1);
  });

  // Derivation: 16 is CROSSFADE_SLIDER_MAX itself — legal, unmapped,
  // passes through.
  it("the slider max passes through", () => {
    expect(crossfadeFromSlider(16)).toBe(16);
  });
});
