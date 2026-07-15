// SILVER layer — eval-expansion round 4 (protocol: docs/design/
// eval-expansion-round1.md). Play-next queue + np-state mirror domain.
// Cases generated adversarially from the queue/npstate contracts by a
// blind generator (no implementation, no existing tests in context),
// then adjudicated against the current implementations. Each case
// carries its derivation. Silver semantics: append-only for the model;
// a human may revoke any case (gold wins).
//
// Dedup record (exactly-covered assertions skipped, not re-asserted):
// - QU-1 (batch self-dedup) is queue.test "self-dedups a duplicated
//   input batch" — dup, skipped.
// - QU-2 (re-queue moves, not duplicates) is queue.test "re-queuing an
//   id moves it" — dup, skipped.
// - QU-9 (partial): edge clamps and unknown-id no-op are queue.test
//   "clamps at the edges" / "is a no-op for ids not in the queue";
//   only the single-element queue implemented below.
// - QU-10 (null current forces the all-null payload) is npstate.test
//   "is fully idle when nothing is playing" — dup, skipped.
// - QU-11 (NaN duration → null) and the +Infinity leg of QU-12 are
//   npstate.test "nulls a duration the engine has not loaded yet";
//   only -Infinity implemented below.
// - QU-14 (filename fallback for a null title tag) is npstate.test
//   "falls back to the filename" — dup, skipped. The generator flagged
//   the title-field doc ("null when nothing is playing") as in tension
//   with a playing-but-untitled track; the fallback resolves it — a
//   playing track's title is never null in the payload.

import { describe, expect, it } from "vitest";
import { dequeue, enqueueNext, queueMove, queueRemove } from "./queue";
import { buildNpState } from "./npstate";
import type { TrackRow } from "./types";

function track(over: Partial<TrackRow> = {}): TrackRow {
  return {
    id: 1,
    path: "/music/Artist/song.flac",
    format: "flac",
    duration_secs: 203,
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
    title: "Song",
    artist: "Artist",
    album: null,
    ...over,
  };
}

describe("silver: enqueueNext identity edges (QU-3/4)", () => {
  // Derivation: the no-op paths (re-queue the current head, empty
  // batch) may return a reference or a copy, but must be value-equal
  // and must never corrupt the input — invariant 2.
  it("re-queuing the id already at the front is a value-level no-op", () => {
    const queue = [3, 1, 2];
    expect(enqueueNext(queue, [3])).toEqual([3, 1, 2]);
    expect(queue).toEqual([3, 1, 2]);
  });

  it("an empty ids batch leaves the queue value-identical", () => {
    const queue = [1, 2];
    expect(enqueueNext(queue, [])).toEqual([1, 2]);
    expect(queue).toEqual([1, 2]);
  });
});

describe("silver: enqueueNext full-overlap reorder (QU-5)", () => {
  // Derivation: "moves instead of duplicating" pushed to its limit —
  // the whole queue re-picked in a new order must leave no tail
  // residue, and neither input array may be mutated.
  it("re-picking the entire queue in a new order replaces it cleanly", () => {
    const queue = [1, 2, 3];
    const ids = [3, 2, 1];
    expect(enqueueNext(queue, ids)).toEqual([3, 2, 1]);
    expect(queue).toEqual([1, 2, 3]);
    expect(ids).toEqual([3, 2, 1]);
  });
});

describe("silver: dequeue purity and rest isolation (QU-6)", () => {
  // Derivation: pop must not shift the caller's array, and `rest` must
  // not alias it — a later push into rest polluting App's queue state
  // would be a classic shared-structure bug.
  it("does not mutate the input and hands back an isolated rest", () => {
    const queue = [7];
    const { id, rest } = dequeue(queue);
    expect(id).toBe(7);
    expect(rest).toEqual([]);
    expect(queue).toEqual([7]);
    rest.push(99);
    expect(queue).toEqual([7]);
  });
});

describe("silver: queueRemove sweep semantics (QU-7/8)", () => {
  // Derivation: the contract names "tracks gone from the library" as a
  // normal case — a removal set that is a superset of the queue must
  // drain it silently, never throw; zero-overlap must be a no-op.
  it("drains on a superset, no-ops on a disjoint set, never mutates", () => {
    const queue = [1, 2, 3];
    expect(queueRemove(queue, new Set([1, 2, 3]))).toEqual([]);
    expect(queueRemove(queue, new Set([9]))).toEqual([1, 2, 3]);
    expect(queueRemove(queue, new Set([1, 2, 3, 99]))).toEqual([]);
    expect(queue).toEqual([1, 2, 3]);
  });

  // Derivation: invariant 3 — survivor order is the user's picks; a
  // multi-id removal must keep them position-stable.
  it("multi-id removal keeps survivor order slot for slot", () => {
    expect(queueRemove([4, 8, 15, 16, 23, 42], new Set([8, 23]))).toEqual([4, 15, 16, 42]);
  });
});

describe("silver: queueMove single-element queue (QU-9d)", () => {
  // Derivation: invariant 4 — both directions clamp on a one-item
  // queue; the swap logic must not read out of bounds.
  it("clamps both directions when there is nowhere to go", () => {
    expect(queueMove([7], 7, -1)).toEqual([7]);
    expect(queueMove([7], 7, 1)).toEqual([7]);
  });
});

describe("silver: np-state duration boundary (QU-12/13)", () => {
  // Derivation: invariant 6 lists -Infinity explicitly — an isNaN-only
  // gate would leak it into the payload.
  it("nulls a -Infinity duration like NaN and +Infinity", () => {
    expect(buildNpState(track(), true, null, -Infinity).durationSecs).toBeNull();
  });

  it("passes a zero duration through — zero is finite, not missing", () => {
    expect(buildNpState(track(), false, null, 0).durationSecs).toBe(0);
  });

  // GOLD RULING 2026-07-15: keep as-is (the audio element never
  // reports negative durations; literal finite-gate contract locked —
  // same ruling as r3 PU-2). Was flagged: a negative duration is finite, so the
  // Number.isFinite gate passes it straight to the mini panel. The
  // contract only promises null for non-finite input, so this is the
  // literal reading; the product reading ("corrupt engine metadata
  // must not leak") would null it.
  it("passes a negative duration through (finite ≠ valid — flagged)", () => {
    expect(buildNpState(track(), false, null, -3).durationSecs).toBe(-3);
  });
});
