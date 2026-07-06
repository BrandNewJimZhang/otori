// Library view logic: sort, filter, and the Backstage selection model
// (single / shift-range / cmd-toggle) that batch tag editing will build on.

import { describe, expect, it } from "vitest";
import {
  clickSelect,
  contextTargets,
  displayTitle,
  emptySelection,
  filterTracks,
  sortTracks,
  stepSelect,
  toggleSort,
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
    title: `Track ${id}`,
    artist: null,
    album: null,
    ...over,
  };
}

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
});
