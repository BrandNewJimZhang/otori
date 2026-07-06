// Preference persistence: what survives an app restart and what doesn't.

import { describe, expect, it } from "vitest";
import { loadPrefs, savePrefs } from "./prefs";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
}

describe("prefs", () => {
  it("round-trips volume and sort", () => {
    const s = fakeStorage();
    savePrefs(s, { volume: 0.4, sort: { key: "artist", dir: -1 } });
    expect(loadPrefs(s)).toEqual({ volume: 0.4, sort: { key: "artist", dir: -1 } });
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadPrefs(fakeStorage())).toEqual({ volume: 1, sort: null });
  });

  it("returns defaults when the stored blob is corrupt or out of range", () => {
    const s = fakeStorage();
    s.setItem("otori.prefs", "{not json");
    expect(loadPrefs(s)).toEqual({ volume: 1, sort: null });
    s.setItem("otori.prefs", JSON.stringify({ volume: 9, sort: { key: "nope", dir: 3 } }));
    expect(loadPrefs(s)).toEqual({ volume: 1, sort: null });
  });
});
