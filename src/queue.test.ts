// Play-next queue semantics (audit P1): an explicit user queue that
// preempts the play order. Pure functions, App owns the state.

import { describe, expect, it } from "vitest";
import { dequeue, enqueueNext, queueMove, queueRemove } from "./queue";

describe("enqueueNext", () => {
  it("adds ids at the front, preserving the picked order", () => {
    expect(enqueueNext([], [1, 2])).toEqual([1, 2]);
    expect(enqueueNext([9], [1, 2])).toEqual([1, 2, 9]);
  });

  it("re-queuing an id moves it instead of duplicating", () => {
    expect(enqueueNext([1, 2, 3], [2])).toEqual([2, 1, 3]);
  });
});

describe("dequeue", () => {
  it("pops the head", () => {
    expect(dequeue([5, 6])).toEqual({ id: 5, rest: [6] });
  });

  it("returns null id when empty", () => {
    expect(dequeue([])).toEqual({ id: null, rest: [] });
  });
});

describe("queueRemove", () => {
  it("drops ids that left the library or were unqueued", () => {
    expect(queueRemove([1, 2, 3], new Set([2]))).toEqual([1, 3]);
  });
});

describe("queueMove", () => {
  it("moves an id up and down one slot (audit r5: queue panel reorder)", () => {
    expect(queueMove([1, 2, 3], 2, -1)).toEqual([2, 1, 3]);
    expect(queueMove([1, 2, 3], 2, 1)).toEqual([1, 3, 2]);
  });

  it("clamps at the edges", () => {
    expect(queueMove([1, 2, 3], 1, -1)).toEqual([1, 2, 3]);
    expect(queueMove([1, 2, 3], 3, 1)).toEqual([1, 2, 3]);
  });

  it("is a no-op for ids not in the queue", () => {
    expect(queueMove([1, 2], 9, 1)).toEqual([1, 2]);
  });
});
