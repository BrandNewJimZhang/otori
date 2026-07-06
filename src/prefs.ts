// UI preference persistence (audit P1: volume/sort reset on every
// launch). localStorage is a preference cache, not authoritative data —
// invalid blobs fall back to defaults instead of failing fast.

import type { SortSpec } from "./library";

export interface Prefs {
  volume: number;
  sort: SortSpec | null;
}

const KEY = "otori.prefs";
const DEFAULTS: Prefs = { volume: 1, sort: null };
const SORT_KEYS = new Set(["title", "artist", "album", "duration_secs", "format"]);

export function loadPrefs(storage: Storage): Prefs {
  const raw = storage.getItem(KEY);
  if (raw == null) return DEFAULTS;
  try {
    const p = JSON.parse(raw) as Prefs;
    const volumeOk = typeof p.volume === "number" && p.volume >= 0 && p.volume <= 1;
    const sortOk =
      p.sort === null || (SORT_KEYS.has(p.sort?.key) && (p.sort?.dir === 1 || p.sort?.dir === -1));
    if (!volumeOk || !sortOk) return DEFAULTS;
    return { volume: p.volume, sort: p.sort };
  } catch {
    return DEFAULTS;
  }
}

export function savePrefs(storage: Storage, prefs: Prefs): void {
  storage.setItem(KEY, JSON.stringify(prefs));
}
