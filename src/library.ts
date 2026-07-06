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

/** NFKC + lowercase: fullwidth Ｌａｔｉｎ, katakana width variants, and
    case all collapse — doujin tags mix these freely. */
function norm(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

type FieldKey = "title" | "artist" | "album";
const FIELD_QUALIFIERS = new Set<FieldKey>(["title", "artist", "album"]);

/**
 * Multi-word AND search with optional field qualifiers:
 *   `melt`               any field contains "melt"
 *   `artist:ryo`         artist contains "ryo"
 *   `artist:ryo melt`    both conditions on the same track
 * Unqualified words match title (incl. basename fallback), artist, album.
 */
export function filterTracks(rows: TrackRow[], query: string): TrackRow[] {
  const terms = query.trim().split(/\s+/).filter(Boolean).map((raw) => {
    const m = raw.match(/^(title|artist|album):(.+)$/i);
    if (m && FIELD_QUALIFIERS.has(m[1].toLowerCase() as FieldKey)) {
      return { field: m[1].toLowerCase() as FieldKey, q: norm(m[2]) };
    }
    return { field: null, q: norm(raw) };
  });
  if (terms.length === 0) return rows;

  return rows.filter((t) => {
    const fields: Record<FieldKey, string | null> = {
      title: displayTitle(t),
      artist: t.artist,
      album: t.album,
    };
    return terms.every(({ field, q }) =>
      field
        ? fields[field] != null && norm(fields[field]!).includes(q)
        : Object.values(fields).some((f) => f != null && norm(f).includes(q)),
    );
  });
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

/**
 * Rows a context menu acts on: the selection when the clicked row is part
 * of it (macOS convention), otherwise just the clicked row. Visible order.
 */
export function contextTargets(sel: Selection, visible: TrackRow[], clickedId: number): TrackRow[] {
  if (sel.ids.has(clickedId) && sel.ids.size > 1) {
    return visible.filter((t) => sel.ids.has(t.id));
  }
  return visible.filter((t) => t.id === clickedId);
}
