// Toast stack semantics (audit r5 P1): one notification surface for
// scan reports and transient info — capped, newest kept, dismissable.

import { describe, expect, it } from "vitest";
import { dismissToast, pushToast, TOAST_CAP, type Toast } from "./toasts";

const t = (id: number, text = `t${id}`): Toast => ({ id, text });

describe("pushToast", () => {
  it("appends newest last", () => {
    const list = pushToast([t(1)], t(2));
    expect(list.map((x) => x.id)).toEqual([1, 2]);
  });

  it("drops the oldest beyond the cap", () => {
    let list: Toast[] = [];
    for (let i = 1; i <= TOAST_CAP + 2; i++) list = pushToast(list, t(i));
    expect(list).toHaveLength(TOAST_CAP);
    expect(list[0].id).toBe(3);
    expect(list[list.length - 1].id).toBe(TOAST_CAP + 2);
  });
});

describe("dismissToast", () => {
  it("removes by id and keeps order", () => {
    const list = dismissToast([t(1), t(2), t(3)], 2);
    expect(list.map((x) => x.id)).toEqual([1, 3]);
  });

  it("is a no-op for unknown ids", () => {
    const list = [t(1)];
    expect(dismissToast(list, 99)).toEqual(list);
  });
});
