// Playback order semantics: shuffle permutations and repeat-aware
// stepping. Repeat-one only captures natural track ends — a manual
// skip always moves.

import { describe, expect, it } from "vitest";
import { cycleRepeat, effectiveOrder, nextId, resolveAdvance, shuffledIds, tempoChainedIds, upcomingPreview } from "./playorder";
import { temposCompatible } from "./djmix";

describe("cycleRepeat", () => {
  it("cycles off → all → one → off", () => {
    expect(cycleRepeat("off")).toBe("all");
    expect(cycleRepeat("all")).toBe("one");
    expect(cycleRepeat("one")).toBe("off");
  });
});

describe("shuffledIds", () => {
  const ids = [1, 2, 3, 4, 5];

  it("returns a permutation of the input", () => {
    const out = shuffledIds(ids, null, Math.random);
    expect([...out].sort()).toEqual([...ids].sort());
    expect(ids).toEqual([1, 2, 3, 4, 5]); // input not mutated
  });

  it("puts the playing track first so shuffle never re-queues it", () => {
    expect(shuffledIds(ids, 3, Math.random)[0]).toBe(3);
  });

  it("is deterministic for a deterministic rng", () => {
    const rng = () => 0;
    expect(shuffledIds(ids, null, rng)).toEqual(shuffledIds(ids, null, rng));
  });

  it("handles empty and single-element lists", () => {
    expect(shuffledIds([], null, Math.random)).toEqual([]);
    expect(shuffledIds([7], 7, Math.random)).toEqual([7]);
  });
});

describe("effectiveOrder", () => {
  it("keeps the frozen permutation, drops hidden ids, appends newcomers", () => {
    // Shuffle was frozen as [3,1,5]; 5 got filtered out, 2 and 4 appeared.
    expect(effectiveOrder([1, 2, 3, 4], [3, 1, 5])).toEqual([3, 1, 2, 4]);
  });

  it("is the identity when the permutation covers exactly the visible ids", () => {
    expect(effectiveOrder([1, 2, 3], [2, 3, 1])).toEqual([2, 3, 1]);
  });
});

describe("nextId", () => {
  const order = [10, 20, 30];

  it("advances within the order in both directions", () => {
    expect(nextId(order, 10, 1, "off", false)).toBe(20);
    expect(nextId(order, 20, -1, "off", true)).toBe(10);
  });

  it("replays the current track on natural end with repeat one", () => {
    expect(nextId(order, 20, 1, "one", false)).toBe(20);
  });

  it("moves to the neighbor on manual skip even in repeat one", () => {
    expect(nextId(order, 20, 1, "one", true)).toBe(30);
  });

  it("stops at the edges when repeat is off", () => {
    expect(nextId(order, 30, 1, "off", false)).toBeNull();
    expect(nextId(order, 10, -1, "off", true)).toBeNull();
  });

  it("wraps at the edges when repeat is all", () => {
    expect(nextId(order, 30, 1, "all", false)).toBe(10);
    expect(nextId(order, 10, -1, "all", true)).toBe(30);
  });

  it("stops when nothing is playing or the track left the order", () => {
    expect(nextId(order, null, 1, "all", false)).toBeNull();
    expect(nextId(order, 99, 1, "all", false)).toBeNull();
    expect(nextId([], null, 1, "all", false)).toBeNull();
  });
});

describe("resolveAdvance", () => {
  const visible = [1, 2, 3, 4, 5];

  it("consumes the queue head on a forward step", () => {
    const r = resolveAdvance(visible, [4, 2], 1, null, "off", 1, true);
    expect(r).toEqual({ id: 4, queue: [2], fromQueue: true });
  });

  it("skips queued ids that left the library, pruning them", () => {
    const r = resolveAdvance(visible, [99, 4], 1, null, "off", 1, true);
    expect(r).toEqual({ id: 4, queue: [], fromQueue: true });
  });

  it("falls through an exhausted queue to the play order, pruned", () => {
    const r = resolveAdvance(visible, [99, 98], 1, null, "off", 1, true);
    expect(r).toEqual({ id: 2, queue: [], fromQueue: false });
  });

  it("never touches the queue stepping backwards", () => {
    const r = resolveAdvance(visible, [4], 2, null, "off", -1, true);
    expect(r).toEqual({ id: 1, queue: [4], fromQueue: false });
  });

  it("repeat-one natural end replays the current track over the queue", () => {
    const r = resolveAdvance(visible, [4], 2, null, "one", 1, false);
    expect(r).toEqual({ id: 2, queue: [4], fromQueue: false });
  });

  it("repeat-one manual skip still consumes the queue", () => {
    const r = resolveAdvance(visible, [4], 2, null, "one", 1, true);
    expect(r).toEqual({ id: 4, queue: [], fromQueue: true });
  });

  it("walks the frozen shuffle permutation when one is given", () => {
    const r = resolveAdvance(visible, [], 3, [3, 1, 5, 2, 4], "off", 1, true);
    expect(r).toEqual({ id: 1, queue: [], fromQueue: false });
  });

  it("stops (null) at the order edge with repeat off", () => {
    const r = resolveAdvance(visible, [], 5, null, "off", 1, false);
    expect(r).toEqual({ id: null, queue: [], fromQueue: false });
  });

  it("wraps with repeat all", () => {
    const r = resolveAdvance(visible, [], 5, null, "all", 1, false);
    expect(r).toEqual({ id: 1, queue: [], fromQueue: false });
  });
});

describe("upcomingPreview", () => {
  const visible = [1, 2, 3, 4, 5];

  it("walks the order from the current track, skipping queued ids", () => {
    expect(upcomingPreview(visible, [3], 1, null, "off", 5)).toEqual([2, 4, 5]);
  });

  it("previews repeat-one as repeat-all — the panel shows where skips go", () => {
    expect(upcomingPreview(visible, [], 4, null, "one", 5)).toEqual([5, 1, 2, 3]);
  });

  it("stops at the edge with repeat off", () => {
    expect(upcomingPreview(visible, [], 4, null, "off", 5)).toEqual([5]);
  });

  it("stops after wrapping once under repeat all", () => {
    expect(upcomingPreview(visible, [], 3, null, "all", 99).length).toBeLessThanOrEqual(5);
  });

  it("caps the walk at count entries", () => {
    expect(upcomingPreview(visible, [], 1, null, "off", 2)).toEqual([2, 3]);
  });

  it("follows the frozen shuffle permutation", () => {
    expect(upcomingPreview(visible, [], 3, [3, 1, 5, 2, 4], "off", 3)).toEqual([1, 5, 2]);
  });

  it("is empty when nothing is playing", () => {
    expect(upcomingPreview(visible, [], null, null, "off", 5)).toEqual([]);
  });
});

describe("tempoChainedIds", () => {
  // tail↔head grids: chain compatibility is outgoing-tail vs
  // incoming-head, same authority as transition planning.
  const grids = new Map<number, { tail: number | null; head: number | null }>([
    [1, { tail: 128, head: 128 }],
    [2, { tail: 126, head: 126 }],
    [3, { tail: 174, head: 174 }],
    [4, { tail: 172, head: 172 }],
    [5, { tail: 90, head: 90 }],
  ]);
  const grid = (id: number) => grids.get(id) ?? { tail: null, head: null };
  const seq = (...vals: number[]) => {
    let i = 0;
    return () => vals[i++ % vals.length];
  };

  it("returns a permutation of the input", () => {
    const out = tempoChainedIds([1, 2, 3, 4, 5], null, seq(0.9, 0.1, 0.5, 0.3), grid);
    expect([...out].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("chains tempo-compatible neighbors when candidates exist", () => {
    // 128/126 mix; 174/172 mix (and fold against 90 → 1.933/1.911: no).
    // 90 folds vs 174 → 174/2/90 = 0.9667 ✓ compatible! But 90 vs 128:
    // 128/90 = 1.42, no fold (≤1.5), incompatible.
    for (let trial = 0; trial < 20; trial++) {
      const out = tempoChainedIds([1, 2, 3, 4, 5], null, Math.random, grid);
      // Count adjacent incompatible pairs: greedy chaining must leave
      // at most the unavoidable minimum. This 5-track set always has a
      // fully compatible hamiltonian path? 1-2 (128/126 ok), 2-... 126 vs
      // 174: 174/126=1.38 no fold, incompatible. 126 vs 90: 90*... 126/90=1.4 no.
      // So {1,2} island vs {3,4,5} chain (174-172-90 via folding).
      // Any permutation has ≥1 break; greedy must not exceed 1.
      let breaks = 0;
      for (let i = 0; i + 1 < out.length; i++) {
        const a = grid(out[i]).tail;
        const b = grid(out[i + 1]).head;
        if (a != null && b != null && !temposCompatible(a, b)) breaks++;
      }
      expect(breaks).toBeLessThanOrEqual(1);
    }
  });

  it("pins the playing track first like shuffledIds", () => {
    expect(tempoChainedIds([1, 2, 3], 2, Math.random, grid)[0]).toBe(2);
  });

  it("treats missing grids as wildcards, never blocking the chain", () => {
    const nullGrid = () => ({ tail: null, head: null });
    const out = tempoChainedIds([1, 2, 3, 4], null, Math.random, nullGrid);
    expect([...out].sort()).toEqual([1, 2, 3, 4]);
  });

  it("handles empty and single-element lists", () => {
    expect(tempoChainedIds([], null, Math.random, grid)).toEqual([]);
    expect(tempoChainedIds([7], 7, Math.random, grid)).toEqual([7]);
  });
});
