// Library view logic: sort, filter, and the Backstage selection model
// (single / shift-range / cmd-toggle) that batch tag editing will build on.

import { describe, expect, it } from "vitest";
import {
  clickSelect,
  COLUMNS,
  contextTargets,
  displayTitle,
  edgeSelect,
  emptySelection,
  filterTracks,
  formatBpm,
  selectAll,
  scrollAnchorId,
  sortTracks,
  stepSelect,
  toggleColumn,
  toggleSort,
  typeAheadSelect,
  visibleColumns,
  type Selection,
} from "./library";
import type { TrackRow } from "./types";

function track(id: number, over: Partial<TrackRow> = {}): TrackRow {
  return {
    id,
    path: `/music/${id}.flac`,
    format: "flac",
    duration_secs: id * 10,
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

describe("column visibility", () => {
  it("all columns are visible by default, in registry order", () => {
    expect(visibleColumns([]).map((c) => c.key)).toEqual(COLUMNS.map((c) => c.key));
  });

  it("hidden keys are dropped without disturbing the order of the rest", () => {
    const keys = visibleColumns(["bpm", "format"]).map((c) => c.key);
    expect(keys).toEqual(COLUMNS.map((c) => c.key).filter((k) => k !== "bpm" && k !== "format"));
  });

  it("toggling hides a shown column and shows a hidden one", () => {
    expect(toggleColumn([], "bpm")).toEqual(["bpm"]);
    expect(toggleColumn(["bpm", "format"], "bpm")).toEqual(["format"]);
  });

  it("title cannot be hidden — the table needs one identifying column", () => {
    expect(toggleColumn([], "title")).toEqual([]);
    expect(COLUMNS.find((c) => c.key === "title")?.hideable).toBe(false);
  });

  it("the registry includes the added / analyzed date columns", () => {
    const keys = COLUMNS.map((c) => c.key);
    expect(keys).toContain("first_seen");
    expect(keys).toContain("bpm_analyzed_at");
  });
});

describe("displayTitle", () => {
  it("prefers the tag title, falls back to the file basename", () => {
    expect(displayTitle(track(1, { title: "Hello" }))).toBe("Hello");
    expect(displayTitle(track(1, { title: null, path: "/a/b/song.mp3" }))).toBe("song.mp3");
  });
});

describe("toggleSort", () => {
  it("cycles none → asc → desc → none on the same column", () => {
    const asc = toggleSort(null, "title");
    expect(asc).toEqual({ key: "title", dir: 1 });
    const desc = toggleSort(asc, "title");
    expect(desc).toEqual({ key: "title", dir: -1 });
    expect(toggleSort(desc, "title")).toBeNull();
  });

  it("switching column starts ascending", () => {
    expect(toggleSort({ key: "title", dir: -1 }, "artist")).toEqual({ key: "artist", dir: 1 });
  });
});

describe("sortTracks", () => {
  const rows = [
    track(1, { title: "banana", artist: "Zed", duration_secs: 30 }),
    track(2, { title: "Apple", artist: null, duration_secs: null }),
    track(3, { title: null, path: "/m/cherry.mp3", artist: "amy", duration_secs: 10 }),
  ];

  it("returns the input order when spec is null", () => {
    expect(sortTracks(rows, null).map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it("sorts strings case-insensitively using the display title", () => {
    expect(sortTracks(rows, { key: "title", dir: 1 }).map((t) => t.id)).toEqual([2, 1, 3]);
    expect(sortTracks(rows, { key: "title", dir: -1 }).map((t) => t.id)).toEqual([3, 1, 2]);
  });

  it("sorts numbers with nulls always last", () => {
    expect(sortTracks(rows, { key: "duration_secs", dir: 1 }).map((t) => t.id)).toEqual([3, 1, 2]);
    expect(sortTracks(rows, { key: "duration_secs", dir: -1 }).map((t) => t.id)).toEqual([1, 3, 2]);
  });

  it("sorts null strings last and does not mutate the input", () => {
    const before = rows.map((t) => t.id);
    expect(sortTracks(rows, { key: "artist", dir: 1 }).map((t) => t.id)).toEqual([3, 1, 2]);
    expect(rows.map((t) => t.id)).toEqual(before);
  });

  it("treats bpm ranges as unsortable, grouped last with missing values", () => {
    const bpmRows = [
      track(1, { bpm: 140, bpm_max: 200 }), // variable tempo: no single comparable value
      track(2, { bpm: 128 }),
      track(3), // bpm null
      track(4, { bpm: 174 }),
    ];
    expect(sortTracks(bpmRows, { key: "bpm", dir: 1 }).map((t) => t.id)).toEqual([2, 4, 1, 3]);
    expect(sortTracks(bpmRows, { key: "bpm", dir: -1 }).map((t) => t.id)).toEqual([4, 2, 1, 3]);
  });

  it("sorts by added / analyzed timestamps (ISO strings compare lexically)", () => {
    const dated = [
      track(1, { first_seen: "2026-07-03 08:00:00", bpm_analyzed_at: null }),
      track(2, { first_seen: "2026-07-01 09:00:00", bpm_analyzed_at: "2026-07-05 10:00:00" }),
      track(3, { first_seen: "2026-07-02 07:00:00", bpm_analyzed_at: "2026-07-04 11:00:00" }),
    ];
    expect(sortTracks(dated, { key: "first_seen", dir: 1 }).map((t) => t.id)).toEqual([2, 3, 1]);
    expect(sortTracks(dated, { key: "first_seen", dir: -1 }).map((t) => t.id)).toEqual([1, 3, 2]);
    // Pending analysis (null) sorts last in both directions, like other nulls.
    expect(sortTracks(dated, { key: "bpm_analyzed_at", dir: 1 }).map((t) => t.id)).toEqual([3, 2, 1]);
    expect(sortTracks(dated, { key: "bpm_analyzed_at", dir: -1 }).map((t) => t.id)).toEqual([2, 3, 1]);
  });
});

describe("formatBpm", () => {
  it("rounds a verified single tempo to an integer", () => {
    expect(formatBpm(track(1, { bpm: 128.4 }))).toBe("128");
    expect(formatBpm(track(1, { bpm: 174.6 }))).toBe("175");
  });

  it("renders a variable tempo as a rounded range", () => {
    expect(formatBpm(track(1, { bpm: 139.7, bpm_max: 200.2 }))).toBe("140–200");
  });

  it("hedges an unverified hint and dashes the unknown", () => {
    expect(formatBpm(track(1, { bpm_hint: 184.5 }))).toBe("≈185");
    expect(formatBpm(track(1))).toBe("—");
  });
});

describe("filterTracks", () => {
  const rows = [
    track(1, { title: "Senbonzakura", artist: "Kurousa-P", album: "Vocalo Best" }),
    track(2, { title: "Melt", artist: "ryo", album: null }),
    track(3, { title: null, path: "/m/untagged song.mp3", artist: null, album: null }),
  ];

  it("matches title, artist, album, and basename, case-insensitively", () => {
    expect(filterTracks(rows, "senbon").map((t) => t.id)).toEqual([1]);
    expect(filterTracks(rows, "RYO").map((t) => t.id)).toEqual([2]);
    expect(filterTracks(rows, "vocalo").map((t) => t.id)).toEqual([1]);
    expect(filterTracks(rows, "untagged").map((t) => t.id)).toEqual([3]);
  });

  it("blank query returns everything", () => {
    expect(filterTracks(rows, "  ")).toEqual(rows);
  });

  it("multi-word queries AND across fields", () => {
    // "kurousa vocalo" spans artist + album of the same track.
    expect(filterTracks(rows, "kurousa vocalo").map((t) => t.id)).toEqual([1]);
    // Words matching different tracks only → no result.
    expect(filterTracks(rows, "kurousa ryo")).toEqual([]);
  });

  it("matches across Unicode width variants (NFKC)", () => {
    const jp = [
      track(10, { title: "メルト", artist: "ｒｙｏ" }), // fullwidth latin artist
      track(11, { title: "Ｓｅｎｂｏｎ", artist: null }), // fullwidth title
    ];
    // Halfwidth query finds fullwidth-tagged artist.
    expect(filterTracks(jp, "ryo").map((t) => t.id)).toEqual([10]);
    expect(filterTracks(jp, "senbon").map((t) => t.id)).toEqual([11]);
    // Katakana query still exact-matches katakana.
    expect(filterTracks(jp, "メルト").map((t) => t.id)).toEqual([10]);
  });

  it("field-qualified queries restrict to one field", () => {
    expect(filterTracks(rows, "artist:ryo").map((t) => t.id)).toEqual([2]);
    // "ryo" appears in no title, so qualifying flips the result off.
    expect(filterTracks(rows, "title:ryo")).toEqual([]);
    expect(filterTracks(rows, "album:vocalo").map((t) => t.id)).toEqual([1]);
    // Qualifier mixes with free words (AND).
    expect(filterTracks(rows, "artist:kurousa senbon").map((t) => t.id)).toEqual([1]);
  });
});

describe("contextTargets", () => {
  const rows = [track(1), track(2), track(3)];
  const none = { shift: false, meta: false };

  it("right-click outside the selection targets just the clicked row", () => {
    const sel = clickSelect(emptySelection, rows, 1, none);
    expect(contextTargets(sel, rows, 3).map((t) => t.id)).toEqual([3]);
  });

  it("right-click inside a multi-selection targets all selected rows in visible order", () => {
    let sel = clickSelect(emptySelection, rows, 3, none);
    sel = clickSelect(sel, rows, 1, { shift: false, meta: true });
    expect(contextTargets(sel, rows, 3).map((t) => t.id)).toEqual([1, 3]);
  });

  it("single selection behaves like a plain click", () => {
    const sel = clickSelect(emptySelection, rows, 2, none);
    expect(contextTargets(sel, rows, 2).map((t) => t.id)).toEqual([2]);
  });

  it("clicked row missing from the visible list yields nothing", () => {
    expect(contextTargets(emptySelection, rows, 99)).toEqual([]);
  });
});

describe("selection model", () => {
  const rows = [track(1), track(2), track(3), track(4), track(5)];
  const none = { shift: false, meta: false };

  it("plain click selects exactly one row and sets the anchor", () => {
    const sel = clickSelect(emptySelection, rows, 3, none);
    expect([...sel.ids]).toEqual([3]);
    expect(sel.anchor).toBe(3);
  });

  it("cmd-click toggles membership without clearing others", () => {
    let sel = clickSelect(emptySelection, rows, 2, none);
    sel = clickSelect(sel, rows, 4, { shift: false, meta: true });
    expect([...sel.ids].sort()).toEqual([2, 4]);
    sel = clickSelect(sel, rows, 2, { shift: false, meta: true });
    expect([...sel.ids]).toEqual([4]);
  });

  it("shift-click selects the contiguous range from the anchor", () => {
    let sel = clickSelect(emptySelection, rows, 2, none);
    sel = clickSelect(sel, rows, 5, { shift: true, meta: false });
    expect([...sel.ids].sort()).toEqual([2, 3, 4, 5]);
    expect(sel.anchor).toBe(2);
    // Range works upward from the same anchor too.
    sel = clickSelect(sel, rows, 1, { shift: true, meta: false });
    expect([...sel.ids].sort()).toEqual([1, 2]);
  });

  it("arrow keys move a single selection and clamp at the edges", () => {
    let sel: Selection = clickSelect(emptySelection, rows, 4, none);
    sel = stepSelect(sel, rows, 1);
    expect([...sel.ids]).toEqual([5]);
    sel = stepSelect(sel, rows, 1);
    expect([...sel.ids]).toEqual([5]);
  });

  it("arrow keys with no selection start from the list edge", () => {
    expect([...stepSelect(emptySelection, rows, 1).ids]).toEqual([1]);
    expect([...stepSelect(emptySelection, rows, -1).ids]).toEqual([5]);
  });

  it("selection survives an empty visible list without crashing", () => {
    expect(stepSelect(emptySelection, [], 1)).toEqual(emptySelection);
  });

  it("shift-arrows extend a range from the anchor (audit P1)", () => {
    let sel: Selection = clickSelect(emptySelection, rows, 2, none);
    sel = stepSelect(sel, rows, 1, true);
    expect([...sel.ids].sort()).toEqual([2, 3]);
    sel = stepSelect(sel, rows, 1, true);
    expect([...sel.ids].sort()).toEqual([2, 3, 4]);
    // Reversing direction shrinks the range back toward the anchor.
    sel = stepSelect(sel, rows, -1, true);
    expect([...sel.ids].sort()).toEqual([2, 3]);
    expect(sel.anchor).toBe(2);
  });

  it("shift-arrows extend upward too", () => {
    let sel: Selection = clickSelect(emptySelection, rows, 3, none);
    sel = stepSelect(sel, rows, -1, true);
    expect([...sel.ids].sort()).toEqual([2, 3]);
  });

  it("selectAll selects the visible list", () => {
    const sel = selectAll(clickSelect(emptySelection, rows, 2, none), rows);
    expect([...sel.ids].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(sel.anchor).toBe(2);
  });

  it("edgeSelect jumps to first/last (Home/End)", () => {
    expect([...edgeSelect(rows, "first").ids]).toEqual([1]);
    expect([...edgeSelect(rows, "last").ids]).toEqual([5]);
    expect(edgeSelect([], "first")).toEqual(emptySelection);
  });
});

describe("typeAheadSelect", () => {
  const rows = [
    track(1, { title: "Bad Apple!!" }),
    track(2, { title: "Brain Power" }),
    track(3, { title: "Ｂｒａｉｎ Ｄｉｖｅｒ" }), // fullwidth (NFKC folds)
    track(4, { title: null, path: "/m/conflict.mp3" }),
  ];

  it("jumps to the first title starting with the buffer", () => {
    expect([...typeAheadSelect(emptySelection, rows, "br").ids]).toEqual([2]);
  });

  it("repeating the prefix walks to the next match, wrapping around", () => {
    const first = typeAheadSelect(emptySelection, rows, "br");
    const second = typeAheadSelect(first, rows, "br");
    expect([...second.ids]).toEqual([3]); // NFKC folds fullwidth
    const third = typeAheadSelect(second, rows, "br");
    expect([...third.ids]).toEqual([2]);
  });

  it("matches the basename fallback and falls back to contains", () => {
    expect([...typeAheadSelect(emptySelection, rows, "conf").ids]).toEqual([4]);
    expect([...typeAheadSelect(emptySelection, rows, "apple").ids]).toEqual([1]);
  });

  it("no match leaves the selection unchanged", () => {
    const sel = typeAheadSelect(emptySelection, rows, "zzz");
    expect(sel).toEqual(emptySelection);
  });
});

describe("scrollAnchorId", () => {
  const rows = [track(1), track(2), track(3)];

  it("prefers the selection anchor when it is still visible", () => {
    const sel: Selection = { ids: new Set([2]), anchor: 2 };
    expect(scrollAnchorId(sel, 3, rows)).toBe(2);
  });

  it("falls back to the playing track when the selection anchor is filtered out", () => {
    const sel: Selection = { ids: new Set([99]), anchor: 99 };
    expect(scrollAnchorId(sel, 3, rows)).toBe(3);
  });

  it("uses the playing track when nothing is selected", () => {
    expect(scrollAnchorId(emptySelection, 1, rows)).toBe(1);
  });

  it("returns null when neither candidate is in the visible list", () => {
    const sel: Selection = { ids: new Set([99]), anchor: 99 };
    expect(scrollAnchorId(sel, 88, rows)).toBeNull();
    expect(scrollAnchorId(emptySelection, null, rows)).toBeNull();
  });
});
