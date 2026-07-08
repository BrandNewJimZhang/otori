// Inspector pure logic: merge N selected tracks into per-field display
// state, diff user edits into the FieldChange[] the IPC write takes,
// and render the CLI-equivalent command (L5: the GUI teaches the
// automation surface by example). Component code stays a thin renderer.

import type { ArtworkInfo, FieldChange, RawLyrics, WritableField } from "./ipc";

export const WRITABLE_FIELDS: WritableField[] = ["title", "artist", "album"];

/** Placeholder for disagreeing fields in batch mode (never written). */
export const MULTIPLE = "⟨multiple⟩";

/** One field across the selection: agreed value, disagreement, or all-empty. */
export type MergedField =
  | { kind: "agree"; value: string }
  | { kind: "multiple" }
  | { kind: "empty" };

export type MergedFields = Record<WritableField, MergedField>;

/** User input per field; null = untouched (input still shows the merged state). */
export type FieldEdits = Record<WritableField, string | null>;

export const noEdits: FieldEdits = { title: null, artist: null, album: null };

export function mergeField(values: (string | null)[]): MergedField {
  const first = values[0] ?? null;
  const allSame = values.every((v) => (v ?? null) === first);
  if (!allSame) return { kind: "multiple" };
  return first === null ? { kind: "empty" } : { kind: "agree", value: first };
}

export function mergeTracks(
  tracks: { title: string | null; artist: string | null; album: string | null }[],
): MergedFields {
  return {
    title: mergeField(tracks.map((t) => t.title)),
    artist: mergeField(tracks.map((t) => t.artist)),
    album: mergeField(tracks.map((t) => t.album)),
  };
}

/**
 * Fields the user actually changed: trimmed, non-empty, and different
 * from an agreed value. Untouched fields (null) never write — that is
 * what makes the ⟨multiple⟩ placeholder safe in batch mode.
 */
export function diffEdits(merged: MergedFields, edits: FieldEdits): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of WRITABLE_FIELDS) {
    const edit = edits[field];
    if (edit === null) continue;
    const value = edit.trim();
    if (value === "") continue; // clearing a tag is a CLI-only operation for now
    const current = merged[field];
    if (current.kind === "agree" && current.value === value) continue;
    changes.push({ field, value });
  }
  return changes;
}

/** Double-quote a shell argument, escaping what survives inside "" in POSIX shells. */
function shellQuote(s: string): string {
  return `"${s.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
}

/**
 * The CLI equivalent of a save: one `otori set … --apply` per file.
 * Shown after every apply so humans learn the agent surface for free.
 */
export function buildCliCommand(paths: string[], changes: FieldChange[]): string {
  const flags = changes.map((c) => `--${c.field} ${shellQuote(c.value)}`).join(" ");
  return paths.map((p) => `otori set ${shellQuote(p)} ${flags} --apply`).join("\n");
}

/**
 * Removal targets the embedded picture only — sidecar/folder art is
 * files on disk (Finder's job, not a tag operation).
 */
export function canRemoveCover(art: ArtworkInfo | null): boolean {
  return art?.source === "embedded";
}

/** Lyrics section state: what the editor shows and whether it writes. */
export type LyricsEditor =
  | { kind: "editable"; text: string } // sidecar or none — save overwrites the .lrc
  | { kind: "readonly"; text: string }; // embedded tag — no USLT writer in core

export function lyricsEditorState(raw: RawLyrics | null): LyricsEditor {
  if (raw === null) return { kind: "editable", text: "" };
  return raw.source === "embedded"
    ? { kind: "readonly", text: raw.text }
    : { kind: "editable", text: raw.text };
}

/**
 * Lyrics editor keydown intent. ⌘S saves, Escape reverts — both only
 * when the draft is dirty, so a clean editor never rewrites the .lrc
 * and a clean Esc falls through to the app router's blur.
 */
export function lyricsKeyIntent(
  combo: { key: string; meta: boolean },
  dirty: boolean,
): "save" | "revert" | "none" {
  if (!dirty) return "none";
  if (combo.meta && combo.key.toLowerCase() === "s") return "save";
  if (!combo.meta && combo.key === "Escape") return "revert";
  return "none";
}
