// Backstage library view logic: sort, filter, selection. Pure functions
// so table interaction is testable without the DOM; App.tsx owns state.

import type { TrackRow } from "./types";

export function displayTitle(t: TrackRow): string {
  return t.title ?? t.path.split("/").pop() ?? t.path;
}

// ---- sorting ----

export type SortKey =
  | "title"
  | "artist"
  | "album"
  | "duration_secs"
  | "bpm"
  | "format"
  | "first_seen"
  | "bpm_analyzed_at";

export interface SortSpec {
  key: SortKey;
  dir: 1 | -1;
}

// ---- columns ----

export interface ColumnSpec {
  key: SortKey;
  label: string;
  className?: string;
  resizable?: boolean;
  /** false = always shown (the table needs one identifying column). */
  hideable: boolean;
}

/** Column registry (SSOT): order, labels, and hideability for the
    Backstage table; prefs validate hidden keys against it. */
export const COLUMNS: readonly ColumnSpec[] = [
  { key: "title", label: "Title", resizable: true, hideable: false },
  { key: "artist", label: "Artist", resizable: true, hideable: true },
  { key: "album", label: "Album", resizable: true, hideable: true },
  { key: "duration_secs", label: "Time", className: "col-duration", hideable: true },
  { key: "bpm", label: "BPM", className: "col-bpm", hideable: true },
  { key: "format", label: "Format", className: "col-format", hideable: true },
  { key: "first_seen", label: "Added", className: "col-date", hideable: true },
  { key: "bpm_analyzed_at", label: "Analyzed", className: "col-date", hideable: true },
];

/** Registry order minus the hidden set. */
export function visibleColumns(hidden: readonly SortKey[]): ColumnSpec[] {
  return COLUMNS.filter((c) => !hidden.includes(c.key));
}

/** Flip one column's visibility; non-hideable keys are a no-op. */
export function toggleColumn(hidden: readonly SortKey[], key: SortKey): SortKey[] {
  const spec = COLUMNS.find((c) => c.key === key);
  if (!spec?.hideable) return [...hidden];
  return hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key];
}

/** Column header click cycle: none → asc → desc → none. */
export function toggleSort(spec: SortSpec | null, key: SortKey): SortSpec | null {
  if (spec?.key !== key) return { key, dir: 1 };
  return spec.dir === 1 ? { key, dir: -1 } : null;
}

export function sortTracks(rows: TrackRow[], spec: SortSpec | null): TrackRow[] {
  if (!spec) return rows;
  const { key, dir } = spec;
  const val = (t: TrackRow) => {
    if (key === "title") return displayTitle(t);
    // A bpm range (variable tempo / soflan) has no single comparable
    // value; ranking it by its lower bound would call 140–200 "slower"
    // than a straight 150. Group ranges with the unknowns instead.
    if (key === "bpm" && t.bpm_max != null) return null;
    return t[key];
  };
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

/** BPM display: verified tempo, a min–max range (variable/soflan), an
    unverified hint ("≈185"), or "—". Whole numbers throughout — the
    detector's confidence doesn't support tenths, and the inspector
    already rounds. */
export function formatBpm(t: TrackRow): string {
  if (t.bpm != null) {
    if (t.bpm_max != null) return `${Math.round(t.bpm)}–${Math.round(t.bpm_max)}`;
    return `${Math.round(t.bpm)}`;
  }
  if (t.bpm_hint != null) return `≈${Math.round(t.bpm_hint)}`;
  return "—";
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
    // Fold BEFORE parsing the qualifier: an IME slip like ａｒｔｉｓｔ：
    // (fullwidth colon U+FF1A) must qualify exactly like artist:. The
    // regex still requires a non-empty needle — a dangling "artist:"
    // stays a literal (gold ruling: the mid-typing state self-corrects).
    const folded = norm(raw);
    const m = folded.match(/^(title|artist|album):(.+)$/);
    if (m && FIELD_QUALIFIERS.has(m[1] as FieldKey)) {
      return { field: m[1] as FieldKey, q: m[2] };
    }
    return { field: null, q: folded };
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

/**
 * Which track a scroll re-anchor should target: the selection anchor
 * (the user's focus) when it survived the reorder/filter, else the
 * playing track, else null (caller falls back to the top). Drives both
 * the sort re-anchor and the Stage-exit scroll.
 */
export function scrollAnchorId(
  sel: Selection,
  playingId: number | null,
  visible: TrackRow[],
): number | null {
  if (sel.anchor != null && visible.some((t) => t.id === sel.anchor)) return sel.anchor;
  if (playingId != null && visible.some((t) => t.id === playingId)) return playingId;
  return null;
}

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

/** ↑/↓ moves a single selection; from nothing, enters at the list edge.
    With `extend` (Shift), grows/shrinks a range from the anchor. */
export function stepSelect(
  sel: Selection,
  visible: TrackRow[],
  offset: 1 | -1,
  extend = false,
): Selection {
  if (visible.length === 0) return sel;
  const cur = sel.anchor != null ? visible.findIndex((t) => t.id === sel.anchor) : -1;
  if (extend && cur >= 0 && sel.ids.size > 0) {
    // The moving edge is the selected end farthest from the anchor
    // (the non-anchor end); stepping it grows or shrinks the range.
    const selectedIdx = visible
      .map((t, i) => (sel.ids.has(t.id) ? i : -1))
      .filter((i) => i >= 0);
    const lo0 = Math.min(...selectedIdx);
    const hi0 = Math.max(...selectedIdx);
    const edge = hi0 > cur ? hi0 : lo0 < cur ? lo0 : cur;
    const next = Math.min(visible.length - 1, Math.max(0, edge + offset));
    const [lo, hi] = cur < next ? [cur, next] : [next, cur];
    return { ids: new Set(visible.slice(lo, hi + 1).map((t) => t.id)), anchor: sel.anchor };
  }
  const next =
    cur < 0
      ? offset === 1
        ? 0
        : visible.length - 1
      : Math.min(visible.length - 1, Math.max(0, cur + offset));
  const id = visible[next].id;
  return { ids: new Set([id]), anchor: id };
}

/** Select every visible row, keeping the current anchor when set. */
export function selectAll(sel: Selection, visible: TrackRow[]): Selection {
  return { ids: new Set(visible.map((t) => t.id)), anchor: sel.anchor };
}

/** Jump the selection to the first/last visible row (Home/End). */
export function edgeSelect(visible: TrackRow[], edge: "first" | "last"): Selection {
  if (visible.length === 0) return emptySelection;
  const id = visible[edge === "first" ? 0 : visible.length - 1].id;
  return { ids: new Set([id]), anchor: id };
}

/**
 * Type-ahead (Finder-style): jump to the first visible track whose
 * display title starts with the typed buffer, searching from after the
 * current anchor first so repeats walk matches; falls back to contains.
 */
export function typeAheadSelect(
  sel: Selection,
  visible: TrackRow[],
  buffer: string,
): Selection {
  const q = buffer.normalize("NFKC").toLowerCase();
  if (!q) return sel;
  const titles = visible.map((t) => displayTitle(t).normalize("NFKC").toLowerCase());
  const from = sel.anchor != null ? visible.findIndex((t) => t.id === sel.anchor) + 1 : 0;
  const order = [...visible.keys()].map((i) => (i + from) % visible.length);
  const hit =
    order.find((i) => titles[i].startsWith(q)) ?? order.find((i) => titles[i].includes(q));
  if (hit == null) return sel;
  const id = visible[hit].id;
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
