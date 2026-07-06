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

const DEFAULTS = {
  volume: 1,
  sort: null,
  shuffle: false,
  repeat: "off",
  theme: "dark",
} as const;

describe("prefs", () => {
  it("round-trips every preference", () => {
    const s = fakeStorage();
    const prefs = {
      volume: 0.4,
      sort: { key: "artist", dir: -1 },
      shuffle: true,
      repeat: "one",
      theme: "light",
    } as const;
    savePrefs(s, prefs);
    expect(loadPrefs(s)).toEqual(prefs);
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadPrefs(fakeStorage())).toEqual(DEFAULTS);
  });

  it("fills defaults for fields missing from an older blob", () => {
    const s = fakeStorage();
    s.setItem("otori.prefs", JSON.stringify({ volume: 0.5, sort: null }));
    expect(loadPrefs(s)).toEqual({ ...DEFAULTS, volume: 0.5 });
  });

  it("returns defaults when the stored blob is corrupt or out of range", () => {
    const s = fakeStorage();
    s.setItem("otori.prefs", "{not json");
    expect(loadPrefs(s)).toEqual(DEFAULTS);
    s.setItem("otori.prefs", JSON.stringify({ volume: 9, sort: { key: "nope", dir: 3 } }));
    expect(loadPrefs(s)).toEqual(DEFAULTS);
    s.setItem(
      "otori.prefs",
      JSON.stringify({ volume: 1, sort: null, shuffle: "yes", repeat: "twice", theme: "sepia" }),
    );
    expect(loadPrefs(s)).toEqual(DEFAULTS);
  });
});
