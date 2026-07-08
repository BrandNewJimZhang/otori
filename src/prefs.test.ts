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
  crossfadeSec: 0,
  density: "comfortable",
  columnWidths: {},
  analysisModel: "small",
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
      crossfadeSec: 8,
      density: "compact",
      columnWidths: { title: 320, artist: 140 },
      analysisModel: "standard",
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

  it("invalid density or column widths degrade individually", () => {
    const s = fakeStorage();
    s.setItem(
      "otori.prefs",
      JSON.stringify({ volume: 0.6, sort: null, density: "cozy", columnWidths: { title: -5 } }),
    );
    expect(loadPrefs(s)).toEqual({ ...DEFAULTS, volume: 0.6 });
  });

  it("out-of-range crossfade falls back to 0 without dropping the rest", () => {
    const s = fakeStorage();
    s.setItem("otori.prefs", JSON.stringify({ volume: 0.7, sort: null, crossfadeSec: 999 }));
    expect(loadPrefs(s)).toEqual({ ...DEFAULTS, volume: 0.7 });
  });

  it("accepts the auto (follow-system) theme (audit r5 P2)", () => {
    const s = fakeStorage();
    savePrefs(s, { ...DEFAULTS, sort: null, columnWidths: {}, theme: "auto" });
    expect(loadPrefs(s).theme).toBe("auto");
  });

  it("an invalid analysis model falls back to small without dropping the rest", () => {
    const s = fakeStorage();
    // A future/typo'd model id must not survive load — it would send an
    // unknown id to the engine, which fails fast. Degrade to small alone.
    s.setItem(
      "otori.prefs",
      JSON.stringify({ volume: 0.6, sort: null, analysisModel: "turbo" }),
    );
    const p = loadPrefs(s);
    expect(p.analysisModel).toBe("small");
    expect(p.volume).toBe(0.6);
  });
});
