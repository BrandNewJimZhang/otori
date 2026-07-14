// SILVER layer — eval-expansion round 1 (docs/design/
// eval-expansion-round1.md). Cases generated adversarially from the
// play-order contract by a blind generator (no implementation, no
// existing tests in context), then adjudicated green against the
// current engine. Each case carries its derivation. Silver semantics:
// append-only for the model; a human may revoke any case (gold wins).

import { describe, expect, it } from "vitest";
import { resolveAdvance, nextId, shuffledIds, upcomingPreview } from "./playorder";

describe("silver: single-track library (PO-5)", () => {
  // Derivation: user anchor "predictable behavior at library edges";
  // catches find-next-different-id implementations that spin forever.
  it("repeat-all wraps onto itself in both directions", () => {
    expect(nextId([7], 7, 1, "all", false)).toBe(7);
    const r = resolveAdvance([7], [], 7, null, "all", -1, true);
    expect(r).toEqual({ id: 7, queue: [], fromQueue: false });
  });

  it("repeat-off stops at the natural end", () => {
    expect(nextId([7], 7, 1, "off", false)).toBeNull();
  });
});

describe("silver: filter emptied the view while the queue holds ids (PO-7)", () => {
  // Derivation: "advancing never returns an id absent from visibleIds"
  // × empty-order degeneracy — the crash/loop/ghost-id triple point.
  it("stops cleanly and prunes the whole queue", () => {
    const r = resolveAdvance([], [5, 6], 5, null, "all", 1, false);
    expect(r).toEqual({ id: null, queue: [], fromQueue: false });
  });
});

describe("silver: queue pruning chained into a repeat-all wrap (PO-9)", () => {
  // Derivation: prune × wraparound in ONE advance — head-only pruning
  // or a stale fromQueue flag both surface here.
  it("prunes the dead queue, then wraps the visible order", () => {
    const r = resolveAdvance([1, 2], [9, 8], 2, null, "all", 1, true);
    expect(r).toEqual({ id: 1, queue: [], fromQueue: false });
  });
});

describe("silver: shuffle pinning with a foreign currentId (PO-11c)", () => {
  // Derivation: "never re-queue what's audible" must not inject a
  // ghost id when the playing track isn't part of the shuffled set.
  it("does not inject a currentId that is not in the ids", () => {
    const out = shuffledIds([1, 2, 3, 4], 99, () => 0.5);
    expect(out).toHaveLength(4);
    expect(out).not.toContain(99);
    expect([...out].sort()).toEqual([1, 2, 3, 4]);
  });
});

describe("silver: upcomingPreview termination under hostile inputs", () => {
  // Derivation: "preview never loops forever, never shows the current
  // track, never shows queued ids" — pushed to where the skip rules
  // empty the candidate set.
  it("skips queued ids across a wraparound and stops at the current track (PO-12b)", () => {
    expect(upcomingPreview([1, 2, 3, 4, 5], [5], 4, null, "all", 10)).toEqual([1, 2, 3]);
  });

  it("is empty when everything but the current track is queued (PO-13a)", () => {
    expect(upcomingPreview([1, 2, 3], [2, 3], 1, null, "all", 10)).toEqual([]);
  });

  it("previews repeat-one from the order edge by wrapping like repeat-all (PO-13b)", () => {
    expect(upcomingPreview([1, 2, 3], [], 3, null, "one", 10)).toEqual([1, 2]);
  });

  it("returns empty for count 0 without walking (PO-13c)", () => {
    expect(upcomingPreview([1, 2, 3], [], 1, null, "all", 0)).toEqual([]);
  });
});

describe("silver: the queue may hold the current track itself (PO-14)", () => {
  // Derivation: user anchor "explicit intent beats algorithmic
  // behavior" — queuing the playing track means PLAY IT AGAIN; a
  // dedup reflex that skips the same-id head silently eats the pick.
  it("consumes the head and replays the current track", () => {
    const r = resolveAdvance([1, 2, 3], [2, 3], 2, null, "off", 1, true);
    expect(r).toEqual({ id: 2, queue: [3], fromQueue: true });
  });
});

describe("silver: repeat-one manual skip at the order edge (PO-2b, gold-adjudicated)", () => {
  // Derivation: upcomingPreview previews repeat-one as repeat-all
  // ("the panel answers where skips go") — the transport must go
  // where the panel promised. Gold ruling 2026-07-15: wrap.
  it("wraps to the order head, matching the panel's promise", () => {
    expect(upcomingPreview([1, 2, 3], [], 3, null, "one", 10)).toEqual([1, 2]);
    expect(nextId([1, 2, 3], 3, 1, "one", true)).toBe(1);
  });

  it("wraps backward from the head symmetrically", () => {
    expect(nextId([1, 2, 3], 1, -1, "one", true)).toBe(3);
  });

  it("still replays on a natural end, and still steps mid-order", () => {
    expect(nextId([1, 2, 3], 3, 1, "one", false)).toBe(3); // natural end: replay
    expect(nextId([1, 2, 3], 2, 1, "one", true)).toBe(3); // mid-order: neighbor
  });
});
