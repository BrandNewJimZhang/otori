// UI preference persistence (audit P1: volume/sort reset on every
// launch). localStorage is a preference cache, not authoritative data —
// invalid blobs fall back to defaults instead of failing fast.

import type { SortSpec } from "./library";
import type { RepeatMode } from "./playorder";

export type Theme = "dark" | "light";

export interface Prefs {
  volume: number;
  sort: SortSpec | null;
  shuffle: boolean;
  repeat: RepeatMode;
  theme: Theme;
}

const KEY = "otori.prefs";
const DEFAULTS: Prefs = { volume: 1, sort: null, shuffle: false, repeat: "off", theme: "dark" };
const SORT_KEYS = new Set(["title", "artist", "album", "duration_secs", "format"]);
const REPEAT_MODES = new Set<RepeatMode>(["off", "all", "one"]);
const THEMES = new Set<Theme>(["dark", "light"]);

export function loadPrefs(storage: Storage): Prefs {
  const raw = storage.getItem(KEY);
  if (raw == null) return DEFAULTS;
  try {
    const p = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
    const volumeOk = typeof p.volume === "number" && p.volume >= 0 && p.volume <= 1;
    const sortOk =
      p.sort === null || (SORT_KEYS.has(p.sort?.key) && (p.sort?.dir === 1 || p.sort?.dir === -1));
    const modesOk =
      typeof p.shuffle === "boolean" && REPEAT_MODES.has(p.repeat) && THEMES.has(p.theme);
    if (!volumeOk || !sortOk || !modesOk) return DEFAULTS;
    return { volume: p.volume, sort: p.sort, shuffle: p.shuffle, repeat: p.repeat, theme: p.theme };
  } catch {
    return DEFAULTS;
  }
}

export function savePrefs(storage: Storage, prefs: Prefs): void {
  storage.setItem(KEY, JSON.stringify(prefs));
}
