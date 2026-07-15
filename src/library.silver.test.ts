// SILVER layer — eval-expansion round 2 (protocol: docs/design/
// eval-expansion-round1.md), library view-logic domain. Cases generated
// adversarially from the sort/filter/selection contract by blind
// generators (no implementation, no existing tests in context), then
// adjudicated against the current engine. Each case carries its
// derivation. Silver semantics: append-only for the model; a human may
// revoke any case (gold wins). The round's three red-candidates were
// gold-adjudicated 2026-07-15: LB-3 keep-as-is, LB-4 fixed (fold
// before qualifier parse), LB-16f won't-fix (unreachable upstream) —
// rulings recorded inline at each case.
//
// Dedup notes (specs skipped as already covered by src/library.test.ts):
//   LB-15 (scrollAnchorId precedence, all four branches) — fully covered.
//   LB-14a/c (contextTargets single-selection / clicked-outside) — covered;
//     only the 3-member visible-order case (14b) is implemented below.
//   LB-16a/b/g (single bpm, real range, all-null dash) — covered; only the
//     precedence-chain cases (16c/d/e/f) are implemented below.

import { describe, expect, it } from "vitest";
import {
  clickSelect,
  contextTargets,
  emptySelection,
  filterTracks,
  formatBpm,
  sortTracks,
  stepSelect,
  typeAheadSelect,
  type Selection,
} from "./library";
import type { TrackRow } from "./types";

function track(id: number, over: Partial<TrackRow> = {}): TrackRow {
  return {
    id,
    path: `/music/${id}.flac`,
    format: "flac",
    duration_secs: null,
    replaygain_db: null,
    bpm: null,
    bpm_max: null,
    bpm_confidence: null,
    bpm_hint: null,
    bpm_shaky: false,
    mix_head_bpm: null,
    mix_head_beat_sec: null,
    mix_tail_bpm: null,
    mix_tail_beat_sec: null,
    mix_analyzed: false,
    lyrics_offset_ms: 0,
    first_seen: "2026-07-01 00:00:00",
    bpm_analyzed_at: null,
    title: `Track ${id}`,
    artist: null,
    album: null,
    ...over,
  };
}

describe("silver: NFKC normalization in search (LB-1)", () => {
  // Derivation: doujin tags mix fullwidth latin, halfwidth katakana, and
  // case freely; the filter contract promises they all collapse. Pushed
  // to the qualifier path and to halfwidth dakuten composition (ﾎﾞ → ボ),
  // which naive lowercase-only matching misses.
  const rows = [
    track(1, { artist: "ｒｙｏ(ｓｕｐｅｒｃｅｌｌ)", title: "メルト" }),
    track(2, { artist: "ryo(supercell)", title: "Melt" }),
    track(3, { artist: "RYO", title: "ﾎﾞｰｶﾛｲﾄﾞ体操第一" }),
    track(4, { artist: "riyo", title: "other" }),
  ];

  it("artist qualifier folds fullwidth latin and case, excludes near-misses", () => {
    expect(filterTracks(rows, "artist:ryo").map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it("fullwidth katakana query finds a halfwidth-katakana title (ﾎﾞ composes to ボ)", () => {
    expect(filterTracks(rows, "ボーカロイド").map((t) => t.id)).toEqual([3]);
  });
});

describe("silver: type-ahead normalization in both directions (LB-2)", () => {
  // Derivation: the type-ahead buffer comes from raw keystrokes which may
  // be fullwidth (IME half-committed); titles may be fullwidth too. The
  // fold must apply to BOTH sides, not just the titles.
  const rows = [
    track(1, { title: "Ｍｅｌｔ" }),
    track(2, { title: "magnet" }),
    track(3, { title: "Alice" }),
  ];

  it("ascii buffer matches a fullwidth title", () => {
    const sel = typeAheadSelect(emptySelection, rows, "mel");
    expect([...sel.ids]).toEqual([1]);
    expect(sel.anchor).toBe(1);
  });

  it("fullwidth buffer matches an ascii title", () => {
    const sel = typeAheadSelect(emptySelection, rows, "ｍａ");
    expect([...sel.ids]).toEqual([2]);
    expect(sel.anchor).toBe(2);
  });
});

describe("silver: dangling qualifier 'artist:' (LB-3)", () => {
  // Derivation: a user mid-typing leaves "artist:" with no needle. Spec
  // preference: parse as a qualifier with an empty needle (empty-contains
  // is true on any non-null artist → matches X, null artist Y drops out).
  //
  // GOLD RULING 2026-07-15: keep as-is. The mid-typing state
  // self-corrects on the next keystroke; switching to an empty-needle
  // qualifier would flash "all rows with an artist" mid-type instead.
  // The literal interpretation below is now the locked behavior.
  it("treats 'artist:' as a literal term, not an empty qualifier", () => {
    const rows = [
      track(1, { artist: "ryo", title: "Melt" }),
      track(2, { artist: null, title: "artist: unknown" }),
    ];
    expect(filterTracks(rows, "artist:").map((t) => t.id)).toEqual([2]);
  });
});

describe("silver: qualifier prefix normalization (LB-4, gold-adjudicated)", () => {
  // Derivation: the qualifier regex carries /i, so an uppercase prefix
  // must still qualify; and a fullwidth colon (U+FF1A) — an easy IME
  // slip — must qualify too. Gold ruling 2026-07-15: the raw term is
  // NFKC-folded before the qualifier match, so ａｒｔｉｓｔ：ryo
  // behaves exactly like artist:ryo (zero results were worse than
  // either interpretation).
  const rows = [track(1, { artist: "Ryo" }), track(2, { artist: "miku" })];

  it("uppercase qualifier prefix still qualifies (regex /i)", () => {
    expect(filterTracks(rows, "ARTIST:RYO").map((t) => t.id)).toEqual([1]);
  });

  it("a fullwidth-colon qualifier folds and qualifies", () => {
    expect(filterTracks(rows, "ａｒｔｉｓｔ：ryo").map((t) => t.id)).toEqual([1]);
  });
});

describe("silver: invalid qualifier prefix stays literal (LB-5)", () => {
  // Derivation: "re:" is not a field qualifier, so "re:zero" must search
  // as a literal — anime titles like "Re:Zero" would otherwise become
  // unsearchable. Catches implementations that split on ANY colon.
  it("'re:zero' matches the literal colon title only", () => {
    const rows = [
      track(1, { title: "Re:Zero - Styx Helix" }),
      track(2, { title: "Zero no Tsukaima" }),
    ];
    expect(filterTracks(rows, "re:zero").map((t) => t.id)).toEqual([1]);
  });
});

describe("silver: basename fallback under the title qualifier (LB-6)", () => {
  // Derivation: displayTitle falls back to the file basename, and the
  // title: qualifier is documented to search the DISPLAY title — an
  // untagged file must be findable by title:, but never leak into artist:.
  const row = track(1, {
    title: null,
    artist: null,
    album: null,
    path: "/lib/Senbonzakura (off vocal).flac",
  });

  it("title: qualifier and unqualified search both hit the basename; artist: does not", () => {
    expect(filterTracks([row], "title:senbonzakura")).toEqual([row]);
    expect(filterTracks([row], "senbonzakura")).toEqual([row]);
    expect(filterTracks([row], "artist:senbonzakura")).toEqual([]);
  });
});

describe("silver: AND across a null artist never crashes (LB-7)", () => {
  // Derivation: qualifier × null field × multi-word AND — the crash /
  // false-positive triple point for implementations that call
  // .includes on a null field before the null guard.
  const rows = [
    track(1, { title: "Melt", artist: null }),
    track(2, { title: "Melt (cover)", artist: "ryo" }),
  ];

  it("qualified word ANDed with a free word skips the null-artist row", () => {
    expect(filterTracks(rows, "artist:ryo melt").map((t) => t.id)).toEqual([2]);
    expect(filterTracks(rows, "melt").map((t) => t.id)).toEqual([1, 2]);
    expect(filterTracks(rows, "artist:ryo").map((t) => t.id)).toEqual([2]);
  });
});

describe("silver: degenerate queries and input immutability (LB-8)", () => {
  // Derivation: the split runs /\s+/ on the RAW query, and JS \s matches
  // U+3000 (ideographic space) — a bare IME space must behave like a
  // blank query, not become a one-character term. Existing coverage has
  // "  " (ascii blank) only. Also: view functions must never mutate the
  // rows array App.tsx owns.
  const rows = [
    track(1, { title: "b" }),
    track(2, { title: "a" }),
    track(3, { title: "c" }),
  ];

  it("empty, ascii-blank, and U+3000 queries all return every row in order", () => {
    expect(filterTracks(rows, "")).toEqual(rows);
    expect(filterTracks(rows, "   ")).toEqual(rows);
    expect(filterTracks(rows, "　")).toEqual(rows);
  });

  it("filterTracks and sortTracks leave the input array untouched", () => {
    const snapshot = rows.map((t) => ({ ...t }));
    filterTracks(rows, "a");
    sortTracks(rows, { key: "title", dir: 1 });
    expect(rows).toEqual(snapshot);
  });
});

describe("silver: shift-click with a filtered-out anchor (LB-9)", () => {
  // Derivation: the anchor can be filtered out between clicks; a shift
  // range from a ghost anchor must degrade to a plain select, not throw
  // or select from index -1.
  it("degrades to a plain select when the anchor is not visible", () => {
    const rows = [track(1), track(2), track(3), track(4)];
    const sel: Selection = { ids: new Set([9]), anchor: 9 };
    const out = clickSelect(sel, rows, 3, { shift: true, meta: false });
    expect([...out.ids]).toEqual([3]);
    expect(out.anchor).toBe(3);
  });
});

describe("silver: shift-extend shrinking through the anchor (LB-10)", () => {
  // Derivation: the moving edge is the non-anchor end; stepping it back
  // across the anchor must collapse to the anchor alone and then grow out
  // the other side, keeping the range contiguous and the anchor stable.
  it("collapses onto the anchor and re-grows past it, anchor stable", () => {
    const rows = [track(1), track(2), track(3), track(4), track(5)];
    let sel: Selection = { ids: new Set([3, 4, 5]), anchor: 3 };

    sel = stepSelect(sel, rows, -1, true);
    expect([...sel.ids].sort()).toEqual([3, 4]);
    expect(sel.anchor).toBe(3);

    sel = stepSelect(sel, rows, -1, true);
    expect([...sel.ids]).toEqual([3]);
    expect(sel.anchor).toBe(3);

    sel = stepSelect(sel, rows, -1, true);
    expect([...sel.ids].sort()).toEqual([2, 3]);
    expect(sel.anchor).toBe(3);
  });
});

describe("silver: meta-toggle empties the selection but keeps the anchor (LB-11)", () => {
  // Derivation: cmd-clicking the only selected row leaves zero selected
  // rows, but the anchor must survive so a following shift-click still
  // ranges from it (Finder behavior).
  it("empty selection after toggle still anchors the next shift range", () => {
    const rows = [track(1), track(2), track(3), track(4)];
    let sel: Selection = { ids: new Set([4]), anchor: 4 };

    sel = clickSelect(sel, rows, 4, { shift: false, meta: true });
    expect(sel.ids.size).toBe(0);
    expect(sel.anchor).toBe(4);

    sel = clickSelect(sel, rows, 2, { shift: true, meta: false });
    expect([...sel.ids].sort()).toEqual([2, 3, 4]);
    expect(sel.anchor).toBe(4);
  });
});

describe("silver: type-ahead wrap-around walk from the last row (LB-12)", () => {
  // Derivation: with the anchor on the LAST row the search start
  // (anchor+1) is past the end; the modular walk must wrap to the top
  // and repeats must cycle through all prefix matches.
  const rows = [
    track(1, { title: "Alice" }),
    track(2, { title: "Magnet" }),
    track(3, { title: "Melt" }),
    track(4, { title: "Meteor" }),
  ];

  it("wraps to the first 'me' match and cycles back on repeat", () => {
    let sel: Selection = { ids: new Set([4]), anchor: 4 };
    sel = typeAheadSelect(sel, rows, "me");
    expect([...sel.ids]).toEqual([3]);
    expect(sel.anchor).toBe(3);
    sel = typeAheadSelect(sel, rows, "me");
    expect([...sel.ids]).toEqual([4]);
    expect(sel.anchor).toBe(4);
  });
});

describe("silver: type-ahead degenerate inputs (LB-13)", () => {
  // Derivation: ghost anchor (filtered out), no-match buffer, empty
  // buffer, and the contains fallback — each must either resolve to a
  // sane row or return the selection unchanged, never throw. (No-match
  // with emptySelection and the contains fallback are already covered by
  // library.test.ts; the ghost-anchor and empty-buffer cases are new.)
  const rows = [track(1, { title: "Melt" }), track(2, { title: "Magnet" })];

  it("ghost anchor restarts the search from the top", () => {
    const sel: Selection = { ids: new Set([99]), anchor: 99 };
    const out = typeAheadSelect(sel, rows, "ma");
    expect([...out.ids]).toEqual([2]);
    expect(out.anchor).toBe(2);
  });

  it("no-match and empty buffers return the selection unchanged", () => {
    const sel: Selection = { ids: new Set([99]), anchor: 99 };
    expect(typeAheadSelect(sel, rows, "zzz")).toBe(sel);
    expect(typeAheadSelect(sel, rows, "")).toBe(sel);
  });

  it("falls back to contains when no title starts with the buffer", () => {
    const out = typeAheadSelect(emptySelection, rows, "gnet");
    expect([...out.ids]).toEqual([2]);
    expect(out.anchor).toBe(2);
  });
});

describe("silver: contextTargets multi-selection visible order (LB-14b)", () => {
  // Derivation: macOS convention — right-click inside a 3-member
  // non-contiguous selection acts on the whole selection, emitted in
  // VISIBLE order regardless of selection insertion order. (14a/c —
  // single selection and clicked-outside — are covered by library.test.ts.)
  it("emits a non-contiguous 3-member selection in visible order", () => {
    const rows = [track(1), track(2), track(3), track(4), track(5)];
    const sel: Selection = { ids: new Set([5, 2, 4]), anchor: 2 };
    expect(contextTargets(sel, rows, 4).map((t) => t.id)).toEqual([2, 4, 5]);
  });
});

describe("silver: formatBpm precedence chain (LB-16)", () => {
  // Derivation: bpm > (bpm, bpm_max) range > bpm_hint > dash. The
  // contract must hold when the fields disagree: a range's max without a
  // verified bpm is meaningless, and a hint never overrides a verified
  // tempo. (Single bpm, plain range, and all-null dash are covered by
  // library.test.ts.)
  it("bpm_max without bpm is ignored; hint wins over orphan max", () => {
    expect(formatBpm(track(1, { bpm: null, bpm_max: 210, bpm_hint: 185 }))).toBe("≈185");
  });

  it("bpm_max without bpm and without hint dashes out", () => {
    expect(formatBpm(track(1, { bpm: null, bpm_max: 210, bpm_hint: null }))).toBe("—");
  });

  it("verified bpm beats a lingering hint", () => {
    expect(formatBpm(track(1, { bpm: 128, bpm_hint: 90 }))).toBe("128");
  });

  // GOLD RULING 2026-07-15: won't-fix. The analyzer's range branch
  // requires hi/lo > 1 + STEADY_TOLERANCE (derive.rs, 0.05), so a
  // degenerate range never reaches the UI from real data — this case
  // documents the reliance on that upstream invariant. If derive.rs
  // ever loosens the tolerance, this locked rendering surfaces it.
  it("renders a degenerate range as '174–174' (unreachable upstream)", () => {
    expect(formatBpm(track(1, { bpm: 174, bpm_max: 174 }))).toBe("174–174");
  });
});
