// SILVER layer — eval-expansion round 5 (protocol: docs/design/
// eval-expansion-round1.md). UI-chrome domain: context-menu
// construction (menus), the capped toast stack (toasts), and mix-point
// resolution (mixpoints). Cases generated adversarially from the
// contracts by a blind generator (no implementation, no existing tests
// in context), then adjudicated against the current implementations.
// Silver semantics: append-only for the model; a human may revoke any
// case (gold wins).
//
// Dedup record (exactly-covered assertions skipped, not re-asserted):
// - UC-2 (empty selection) is menus.test "returns nothing for an
//   empty target list" — dup, skipped.
// - UC-3 partial: single/multi item sets and dispatch are menus.test
//   "single target: full menu" / "multi selection: batch menu"; the
//   build-phase purity probe (UC-1) is new, kept below.
// - UC-4 partial: the all-vs-some queue flip is menus.test "multi
//   selection: queue flips to remove only when ALL are queued"; the
//   partial-overlap queueAdd payload leg is new.
// - UC-5 partial: sorted-column-hide clears sort and re-show never
//   clears are menus.test; the hide-unsorted-column leg is menus.test
//   "toggles the clicked column" (no clearSort spy assert there —
//   tightened below).
// - UC-6/UC-8 (eviction order, dismiss unknown id) are toasts.test —
//   dup, skipped.
// - UC-10 (fast path no IPC) is mixpoints.test "reads both ends from
//   the index without IPC" — dup, skipped.
// - UC-11 (analyzed-but-null anchors) is mixpoints.test "analyzed-
//   but-anchorless ends mean plain fade" — dup, skipped.
// - UC-12 (shared IPC across both ends) is mixpoints.test "asks Rust
//   once and shares the result" — the concurrent-call dedup is dup;
//   the REPEAT-call (post-settlement) cache leg is new, kept below.
// - UC-13 partial: rejection → null is mixpoints.test; the
//   rejection-CACHED leg (second call also null, no retry) is new.
//
// Generator ambiguities resolved by the adjudicator without gold:
// - UC-4 (partial-overlap queueAdd: full ids or difference?): the
//   contract routes the doer to App and queueAdd's own contract
//   (queue.ts enqueueNext) self-dedups — passing the full id list is
//   correct layering. Locked green at full-list.
// - UC-8 (same reference or equal copy on miss): dismissToast filters
//   unconditionally — always a new array. Not contract-critical;
//   unasserted.
// - UC-13 ("this once" vs "at most once"): the inflight map never
//   evicts, so a rejection is cached forever — the next TRANSITION
//   retries nothing, but the module comment says "the fallback runs
//   at most once per track", so cached-null is the documented
//   reading. Locked green with the repeat-call probe.

import { beforeEach, describe, expect, it, vi } from "vitest";

const analyzeTrack = vi.fn();
vi.mock("./ipc", () => ({
  analyzeTrack: (...args: unknown[]) => analyzeTrack(...args),
}));

import { columnMenuItems, trackMenuItems, type TrackMenuActions } from "./menus";
import { headMixPoint, tailMixPoint } from "./mixpoints";
import { dismissToast, pushToast, TOAST_CAP, type Toast } from "./toasts";
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
    bpm_source: null,
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

beforeEach(() => {
  analyzeTrack.mockReset();
});

describe("silver: menu construction purity (UC-1)", () => {
  // Derivation: "Pure decision logic — App supplies the doers" means
  // building a menu must fire nothing. The queue flip needs queue
  // membership answered at build time — the tempting shortcut is
  // calling a doer to probe state.
  it("building row and column menus fires zero actions", () => {
    const act = actions();
    const colAct = { toggle: vi.fn(), clearSort: vi.fn() };
    trackMenuItems([track(1)], [1], act);
    trackMenuItems([track(1), track(2)], [], act);
    columnMenuItems(["album"], { key: "artist", dir: 1 }, colAct);
    for (const spy of Object.values(act)) expect(spy).not.toHaveBeenCalled();
    expect(colAct.toggle).not.toHaveBeenCalled();
    expect(colAct.clearSort).not.toHaveBeenCalled();
  });
});

describe("silver: partial queue overlap (UC-4)", () => {
  // Derivation: the flip's keyword is EVERY — one selected id outside
  // the queue keeps "Play next". The add payload is the FULL selected
  // id list (enqueueNext self-dedups downstream; the menu doesn't
  // pre-filter — correct layering, see ambiguity record above).
  it("a partial overlap stays Play-next and adds the full id list", () => {
    const act = actions();
    const items = trackMenuItems([track(1), track(2), track(3)], [1], act);
    const queueItem = items.find((i) => i.label.includes("next"));
    expect(queueItem).toBeDefined();
    expect(queueItem!.label).toBe("Play 3 next");
    queueItem!.action();
    expect(act.queueAdd).toHaveBeenCalledWith([1, 2, 3]);
    expect(act.queueRemove).not.toHaveBeenCalled();
  });
});

describe("silver: column chooser sort coupling (UC-5)", () => {
  // Derivation: clearSort fires ONLY on "hide the sorted column".
  // Hiding an unrelated column while sorted must leave the sort
  // alone — the menus.test toggle case doesn't assert the clearSort
  // spy; tightened here.
  it("hiding an unsorted column never clears the sort", () => {
    const colAct = { toggle: vi.fn(), clearSort: vi.fn() };
    const items = columnMenuItems([], { key: "artist", dir: 1 }, colAct);
    const album = items.find((i) => i.label.includes("Album"))!;
    album.action();
    expect(colAct.toggle).toHaveBeenCalledWith("album");
    expect(colAct.clearSort).not.toHaveBeenCalled();
  });

  // Derivation: with no sort active, no toggle may reach clearSort.
  it("with sort null, hiding the previously sorted column is just a toggle", () => {
    const colAct = { toggle: vi.fn(), clearSort: vi.fn() };
    const items = columnMenuItems([], null, colAct);
    const artist = items.find((i) => i.label.includes("Artist"))!;
    artist.action();
    expect(colAct.toggle).toHaveBeenCalledWith("artist");
    expect(colAct.clearSort).not.toHaveBeenCalled();
  });
});

describe("silver: toast stack aliasing and the exact cap (UC-7, UC-9)", () => {
  const t = (id: number): Toast => ({ id, text: `t${id}` });

  // Derivation: "pure list semantics" — both operations return new
  // arrays and never mutate the input. Object.freeze turns any
  // in-place shift/splice/push into a throw.
  it("push and dismiss never mutate the input (frozen probe)", () => {
    const full = Object.freeze([t(1), t(2), t(3), t(4)]) as Toast[];
    const partial = Object.freeze([t(1), t(2)]) as Toast[];
    expect(pushToast(full, t(5)).map((x) => x.id)).toEqual([2, 3, 4, 5]);
    expect(pushToast(partial, t(3)).map((x) => x.id)).toEqual([1, 2, 3]);
    expect(dismissToast(full, 2).map((x) => x.id)).toEqual([1, 3, 4]);
    expect(full.map((x) => x.id)).toEqual([1, 2, 3, 4]);
    expect(partial.map((x) => x.id)).toEqual([1, 2]);
  });

  // Derivation: eviction triggers BEYOND the cap, not at it — pushing
  // onto CAP-1 keeps everyone. Pins the > vs >= boundary.
  it("reaching exactly the cap evicts nothing", () => {
    const three = [t(1), t(2), t(3)];
    const out = pushToast(three, t(4));
    expect(out).toHaveLength(TOAST_CAP);
    expect(out[0].id).toBe(1); // the oldest is still here
  });
});

describe("silver: mix-point cache semantics (UC-12, UC-13, UC-14)", () => {
  // Derivation: the inflight map keys by track id and never evicts —
  // repeat calls AFTER settlement still hit the cache. The concurrent
  // leg is locked by mixpoints.test; this pins the sequential one.
  it("repeat calls after settlement reuse the cached verdict", async () => {
    analyzeTrack.mockResolvedValue({
      head: { bpm: 140, beat_sec: 0.5 },
      tail: { bpm: 140, beat_sec: 90.25 },
    });
    const t = track(501);
    await headMixPoint(t);
    await tailMixPoint(t);
    expect(await headMixPoint(t)).toEqual({ bpm: 140, beatSec: 0.5 });
    expect(analyzeTrack).toHaveBeenCalledTimes(1);
  });

  // Derivation: a rejection is cached too ("the fallback runs at most
  // once per track") — the second ask is null WITHOUT a retry. See
  // the ambiguity record: cached-null is the documented reading.
  it("a rejection is cached: the second ask stays null with no retry", async () => {
    analyzeTrack.mockRejectedValue(new Error("decode failed"));
    const t = track(502);
    expect(await tailMixPoint(t)).toBeNull();
    expect(await tailMixPoint(t)).toBeNull();
    expect(await headMixPoint(t)).toBeNull();
    expect(analyzeTrack).toHaveBeenCalledTimes(1);
  });

  // Derivation: the verdict's two ends are independent — head null
  // (beatless intro) must not blank a usable tail, and tail values
  // must not leak into head. Also pins the beat_sec → beatSec rename.
  it("a one-ended verdict resolves each end independently", async () => {
    analyzeTrack.mockResolvedValue({
      head: null,
      tail: { bpm: 122, beat_sec: 310.75 },
    });
    const t = track(503);
    const [head, tail] = await Promise.all([headMixPoint(t), tailMixPoint(t)]);
    expect(head).toBeNull();
    expect(tail).toEqual({ bpm: 122, beatSec: 310.75 });
    expect(analyzeTrack).toHaveBeenCalledTimes(1);
  });
});
