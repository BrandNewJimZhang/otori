// Context-menu construction: row menu (single vs multi selection,
// queue add/remove flip) and the header column chooser. Pure — the
// menus decide labels and which action fires; App supplies the doers.

import { describe, expect, it, vi } from "vitest";
import { columnMenuItems, trackMenuItems, type TrackMenuActions } from "./menus";
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
    bpm_source: null,
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
    artist: `Artist ${id}`,
    album: null,
    ...over,
  };
}

function actions(): TrackMenuActions {
  return {
    play: vi.fn(),
    getInfo: vi.fn(),
    queueAdd: vi.fn(),
    queueRemove: vi.fn(),
    revealInFinder: vi.fn(),
    copyText: vi.fn(),
    reanalyze: vi.fn(),
  };
}

function labels(items: { label: string }[]): string[] {
  return items.map((i) => i.label);
}

function click(items: { label: string; action(): void }[], label: string) {
  const item = items.find((i) => i.label === label);
  if (!item) throw new Error(`no such item: ${label}`);
  item.action();
}

describe("trackMenuItems", () => {
  it("returns nothing for an empty target list", () => {
    expect(trackMenuItems([], [], actions())).toEqual([]);
  });

  it("single target: full menu in row order", () => {
    const items = trackMenuItems([track(1)], [], actions());
    expect(labels(items)).toEqual([
      "Play",
      "Get Info",
      "Play next",
      "Reveal in Finder",
      "Copy title – artist",
      "Copy path",
      "Reanalyze BPM",
    ]);
  });

  it("single target already queued: queue item flips to remove", () => {
    const a = actions();
    const items = trackMenuItems([track(1)], [1], a);
    expect(labels(items)).toContain("Remove from queue");
    click(items, "Remove from queue");
    expect(a.queueRemove).toHaveBeenCalledWith([1]);
  });

  it("single target: play, info, queue, reveal, reanalyze dispatch", () => {
    const a = actions();
    const t = track(7);
    const items = trackMenuItems([t], [], a);
    click(items, "Play");
    expect(a.play).toHaveBeenCalledWith(t);
    click(items, "Get Info");
    expect(a.getInfo).toHaveBeenCalledWith([t]);
    click(items, "Play next");
    expect(a.queueAdd).toHaveBeenCalledWith([7]);
    click(items, "Reveal in Finder");
    expect(a.revealInFinder).toHaveBeenCalledWith("/music/7.flac");
    click(items, "Reanalyze BPM");
    expect(a.reanalyze).toHaveBeenCalledWith([7]);
  });

  it("copies 'title – artist' and trims when artist is missing", () => {
    const a = actions();
    click(trackMenuItems([track(1)], [], a), "Copy title – artist");
    expect(a.copyText).toHaveBeenCalledWith("Track 1 – Artist 1");
    const b = actions();
    click(trackMenuItems([track(2, { artist: null })], [], b), "Copy title – artist");
    expect(b.copyText).toHaveBeenCalledWith("Track 2 –");
  });

  it("falls back to the filename when the title tag is missing", () => {
    const a = actions();
    click(trackMenuItems([track(3, { title: null })], [], a), "Copy title – artist");
    expect(a.copyText).toHaveBeenCalledWith("3.flac – Artist 3");
  });

  it("multi selection: batch menu with counts", () => {
    const items = trackMenuItems([track(1), track(2)], [], actions());
    expect(labels(items)).toEqual([
      "Get Info on 2 tracks",
      "Play 2 next",
      "Copy 2 paths",
      "Reanalyze BPM (2)",
    ]);
  });

  it("multi selection: queue flips to remove only when ALL are queued", () => {
    const targets = [track(1), track(2)];
    expect(labels(trackMenuItems(targets, [1], actions()))).toContain("Play 2 next");
    const a = actions();
    const items = trackMenuItems(targets, [2, 1, 9], a);
    expect(labels(items)).toContain("Remove 2 from queue");
    click(items, "Remove 2 from queue");
    expect(a.queueRemove).toHaveBeenCalledWith([1, 2]);
  });

  it("multi selection: copies newline-joined paths", () => {
    const a = actions();
    click(trackMenuItems([track(1), track(2)], [], a), "Copy 2 paths");
    expect(a.copyText).toHaveBeenCalledWith("/music/1.flac\n/music/2.flac");
  });
});

describe("columnMenuItems", () => {
  it("lists only hideable columns, checkmark = shown", () => {
    const items = columnMenuItems(["album"], null, {
      toggle: () => {},
      clearSort: () => {},
    });
    expect(labels(items).some((l) => l.includes("Title"))).toBe(false); // not hideable
    expect(labels(items)).toContain("✓ Artist");
    expect(labels(items)).toContain(" Album");
  });

  it("toggles the clicked column", () => {
    const toggle = vi.fn();
    click(columnMenuItems([], null, { toggle, clearSort: () => {} }), "✓ Album");
    expect(toggle).toHaveBeenCalledWith("album");
  });

  it("hiding the sorted column also clears the sort", () => {
    const clearSort = vi.fn();
    const items = columnMenuItems([], { key: "album", dir: 1 }, {
      toggle: () => {},
      clearSort,
    });
    click(items, "✓ Album");
    expect(clearSort).toHaveBeenCalled();
  });

  it("showing a hidden column never clears the sort", () => {
    const clearSort = vi.fn();
    const items = columnMenuItems(["album"], { key: "album", dir: 1 }, {
      toggle: () => {},
      clearSort,
    });
    click(items, " Album");
    expect(clearSort).not.toHaveBeenCalled();
  });
});
