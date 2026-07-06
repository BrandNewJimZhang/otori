// Play-next queue semantics (audit P1): an explicit user queue that
// preempts the play order. Pure functions, App owns the state.

import { describe, expect, it } from "vitest";
import { dequeue, enqueueNext, queueRemove } from "./queue";

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
