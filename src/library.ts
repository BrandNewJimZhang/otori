// Backstage library view logic: sort, filter, selection. Pure functions
// so table interaction is testable without the DOM; App.tsx owns state.

import type { TrackRow } from "./types";

export function displayTitle(t: TrackRow): string {
  return t.title ?? t.path.split("/").pop() ?? t.path;
}

// ---- sorting ----

export type SortKey = "title" | "artist" | "album" | "duration_secs" | "format";

export interface SortSpec {
  key: SortKey;
  dir: 1 | -1;
}

/** Column header click cycle: none → asc → desc → none. */
export function toggleSort(spec: SortSpec | null, key: SortKey): SortSpec | null {
  if (spec?.key !== key) return { key, dir: 1 };
  return spec.dir === 1 ? { key, dir: -1 } : null;
}

export function sortTracks(rows: TrackRow[], spec: SortSpec | null): TrackRow[] {
  if (!spec) return rows;
  const { key, dir } = spec;
  const val = (t: TrackRow) => (key === "title" ? displayTitle(t) : t[key]);
  return [...rows].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    // Nulls sort last regardless of direction: missing metadata is
    // "needs fixing", not "smallest value".
    if (va == null) return vb == null ? 0 : 1;
    if (vb == null) return -1;
    const cmp =
      typeof va === "number"
        ? va - (vb as number)
        : va.toLowerCase().localeCompare((vb as string).toLowerCase());
    return cmp * dir;
  });
}

// ---- filtering ----

export function filterTracks(rows: TrackRow[], query: string): TrackRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((t) =>
    [displayTitle(t), t.artist, t.album].some((f) => f?.toLowerCase().includes(q)),
  );
}

// ---- selection (single / shift-range / cmd-toggle) ----

export interface Selection {
  ids: ReadonlySet<number>;
  /** Range anchor for shift-click; null until first plain click. */
  anchor: number | null;
}

export const emptySelection: Selection = { ids: new Set(), anchor: null };

export function clickSelect(
  sel: Selection,
  visible: TrackRow[],
  id: number,
  mods: { shift: boolean; meta: boolean },
): Selection {
  if (mods.shift && sel.anchor != null) {
    const ai = visible.findIndex((t) => t.id === sel.anchor);
    const ci = visible.findIndex((t) => t.id === id);
    if (ai >= 0 && ci >= 0) {
      const [lo, hi] = ai < ci ? [ai, ci] : [ci, ai];
      return { ids: new Set(visible.slice(lo, hi + 1).map((t) => t.id)), anchor: sel.anchor };
    }
  }
  if (mods.meta) {
    const ids = new Set(sel.ids);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    return { ids, anchor: id };
  }
  return { ids: new Set([id]), anchor: id };
}

/** ↑/↓ moves a single selection; from nothing, enters at the list edge. */
export function stepSelect(sel: Selection, visible: TrackRow[], offset: 1 | -1): Selection {
  if (visible.length === 0) return sel;
  const cur = sel.anchor != null ? visible.findIndex((t) => t.id === sel.anchor) : -1;
  const next =
    cur < 0
      ? offset === 1
        ? 0
        : visible.length - 1
      : Math.min(visible.length - 1, Math.max(0, cur + offset));
  const id = visible[next].id;
  return { ids: new Set([id]), anchor: id };
}
