// Backstage tag inspector (design: docs/design/tag-inspector.md):
// Swinsian's side panel, plus what Swinsian cannot show — per-field
// trust (source badge + curated lock). Editing here is the oath: saved
// values land human-sourced and born curated, through the same core
// write path agents use. Pure logic lives in inspector.ts; this file
// only renders and wires.

import { useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  getArtwork,
  getLyricsRaw,
  getTagProvenance,
  removeArtwork,
  setLyricsRaw,
  setTags,
  type ArtworkInfo,
  type RawLyrics,
  type TagProvenance,
  type WritableField,
} from "./ipc";
import {
  buildCliCommand,
  canRemoveCover,
  diffEdits,
  lyricsEditorState,
  lyricsKeyIntent,
  mergeTracks,
  MULTIPLE,
  noEdits,
  WRITABLE_FIELDS,
  type FieldEdits,
} from "./inspector";
import { formatTime } from "./format";
import type { TrackRow } from "./types";

interface Props {
  /** Selected rows, in table order. Empty = the select-something hint. */
  tracks: TrackRow[];
  onClose(): void;
  /** Save landed (tx id): App toasts and refreshes via library-changed. */
  onSaved(txId: number): void;
  /** A non-undoable change landed (cover removal, lyrics): plain toast. */
  onNotice(message: string): void;
  onError(message: string): void;
}

const FIELD_LABELS: Record<WritableField, string> = {
  title: "Title",
  artist: "Artist",
  album: "Album",
};

/** Badge letter + tooltip per provenance source. */
const SOURCE_BADGES: Record<TagProvenance["source"], { letter: string; tip: string }> = {
  human: { letter: "H", tip: "Edited by a person in Ōtori — curated" },
  agent: { letter: "A", tip: "Written by an agent via the CLI" },
  import: { letter: "I", tip: "Imported from the file as scanned" },
  inferred: { letter: "?", tip: "Guessed (filename or heuristics)" },
};

export function InspectorPanel({ tracks, onClose, onSaved, onNotice, onError }: Props) {
  const single = tracks.length === 1 ? tracks[0] : null;
  const merged = mergeTracks(tracks);
  const [edits, setEdits] = useState<FieldEdits>(noEdits);
  const [saving, setSaving] = useState(false);
  const [artwork, setArtwork] = useState<ArtworkInfo | null>(null);
  const [provenance, setProvenance] = useState<TagProvenance[]>([]);
  // Lyrics editor: raw source text, the user's draft (null = untouched),
  // and whether the section is expanded (collapsed summary by default).
  const [rawLyrics, setRawLyrics] = useState<RawLyrics | null>(null);
  const [lyricsDraft, setLyricsDraft] = useState<string | null>(null);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [lyricsSaving, setLyricsSaving] = useState(false);
  // Selection identity: switching rows discards unsaved edits (the
  // inputs are previews of the selection, not a persistent form).
  const selectionKey = tracks.map((t) => t.id).join(",");
  useEffect(() => {
    setEdits(noEdits);
    setLyricsDraft(null);
    setLyricsOpen(false);
  }, [selectionKey]);

  // Artwork + provenance + lyrics are single-track affordances; batch
  // mode shows none of them (whose cover would it be?).
  useEffect(() => {
    let stale = false;
    setArtwork(null);
    setProvenance([]);
    setRawLyrics(null);
    if (!single) return;
    getArtwork(single.path).then((a) => !stale && setArtwork(a)).catch(() => {});
    getTagProvenance(single.id)
      .then((p) => !stale && setProvenance(p))
      .catch(() => {}); // badge-less fields degrade gracefully
    getLyricsRaw(single.path)
      .then((l) => !stale && setRawLyrics(l))
      .catch(() => {}); // section degrades to "No lyrics"
    return () => {
      stale = true;
    };
    // Re-fetch on any library change is App's job (tracks prop refreshes).
  }, [single?.id, single?.path, single?.title, single?.artist, single?.album]);

  const changes = diffEdits(merged, edits);
  const dirty = changes.length > 0;

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const paths = tracks.map((t) => t.path);
      const txId = await setTags(paths, changes);
      setEdits(noEdits);
      if (txId !== null) onSaved(txId);
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function removeCover() {
    if (!single) return;
    try {
      await removeArtwork(single.path);
      // Deliberately no undo handle: the journal cannot restore bytes.
      onNotice("Cover removed");
      const art = await getArtwork(single.path); // fall back to sidecar/folder
      setArtwork(art);
    } catch (e) {
      onError(String(e));
    }
  }

  const lyricsEd = lyricsEditorState(rawLyrics);
  const lyricsDirty = lyricsDraft !== null && lyricsDraft !== lyricsEd.text;

  async function saveLyrics() {
    if (!single || !lyricsDirty || lyricsSaving) return;
    setLyricsSaving(true);
    try {
      await setLyricsRaw(single.path, lyricsDraft!);
      setRawLyrics({ source: "sidecar", text: lyricsDraft! });
      setLyricsDraft(null);
      onNotice("Lyrics saved");
    } catch (e) {
      onError(String(e));
    } finally {
      setLyricsSaving(false);
    }
  }

  const firstInputRef = useRef<HTMLInputElement>(null);

  if (tracks.length === 0) {
    return (
      <aside className="inspector" aria-label="Track inspector">
        <header className="inspector-head">
          <h2>Info</h2>
          <button className="inspector-close" onClick={onClose} aria-label="Close inspector">
            ×
          </button>
        </header>
        <p className="inspector-empty">Select a track to see its tags.</p>
      </aside>
    );
  }

  return (
    <aside className="inspector" aria-label="Track inspector">
      <header className="inspector-head">
        <h2>{single ? "Info" : `${tracks.length} tracks`}</h2>
        <button className="inspector-close" onClick={onClose} aria-label="Close inspector">
          ×
        </button>
      </header>

      {single && (
        <div className="inspector-identity">
          {artwork ? (
            <div className="inspector-art-wrap">
              <img className="inspector-art" src={artwork.dataUrl} alt="" />
              {canRemoveCover(artwork) && (
                <button
                  className="inspector-art-remove"
                  onClick={() => void removeCover()}
                  data-tip="Remove the embedded cover (kept in backups, not undoable)"
                >
                  Remove cover
                </button>
              )}
            </div>
          ) : (
            <div className="inspector-art placeholder" aria-hidden="true" />
          )}
          <div className="inspector-facts">
            <span className="inspector-file">{single.path.split("/").pop()}</span>
            <span className="inspector-props">
              {single.format.toUpperCase()} · {formatTime(single.duration_secs)}
              {single.replaygain_db != null && ` · RG ${single.replaygain_db.toFixed(1)} dB`}
            </span>
            <button
              className="inspector-reveal"
              onClick={() => revealItemInDir(single.path).catch(() => {})}
              data-tip="Reveal in Finder"
            >
              {single.path}
            </button>
          </div>
        </div>
      )}

      <div className="inspector-fields">
        {WRITABLE_FIELDS.map((field) => {
          const m = merged[field];
          const prov = single ? provenance.find((p) => p.field === field) : undefined;
          const edited = edits[field] !== null;
          const shown =
            edits[field] ?? (m.kind === "agree" ? m.value : "");
          return (
            <label className={`inspector-field ${edited ? "edited" : ""}`} key={field}>
              <span className="inspector-label">
                {FIELD_LABELS[field]}
                {prov && (
                  <span
                    className={`prov-badge prov-${prov.source} ${prov.curated ? "curated" : ""}`}
                    data-tip={
                      prov.curated && prov.source !== "human"
                        ? `${SOURCE_BADGES[prov.source].tip} — curated`
                        : SOURCE_BADGES[prov.source].tip
                    }
                  >
                    {prov.curated && <span className="prov-lock" aria-hidden="true" />}
                    {SOURCE_BADGES[prov.source].letter}
                  </span>
                )}
              </span>
              <input
                ref={field === "title" ? firstInputRef : undefined}
                type="text"
                value={shown}
                placeholder={m.kind === "multiple" ? MULTIPLE : ""}
                onChange={(e) => setEdits((prev) => ({ ...prev, [field]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void save();
                  else if (e.key === "Escape" && edited) {
                    // First Esc reverts the field; unedited Esc blurs
                    // via the global router.
                    e.stopPropagation();
                    setEdits((prev) => ({ ...prev, [field]: null }));
                  }
                }}
              />
            </label>
          );
        })}
      </div>

      {single && (
        <section className="inspector-lyrics">
          <button
            className="inspector-lyrics-toggle"
            onClick={() => setLyricsOpen((o) => !o)}
            aria-expanded={lyricsOpen}
          >
            <span className="inspector-label">Lyrics</span>
            <span className="inspector-lyrics-summary">
              {rawLyrics
                ? `${rawLyrics.source} · ${rawLyrics.text.split("\n").length} lines`
                : "none — click to add"}
            </span>
          </button>
          {lyricsOpen &&
            (lyricsEd.kind === "readonly" ? (
              <>
                <textarea
                  className="inspector-lyrics-text"
                  value={lyricsEd.text}
                  readOnly
                  rows={10}
                />
                <p className="inspector-lyrics-note">
                  Embedded in the file's tag — read-only here.
                </p>
              </>
            ) : (
              <>
                <textarea
                  className="inspector-lyrics-text"
                  value={lyricsDraft ?? lyricsEd.text}
                  placeholder="Paste LRC or plain lyrics…"
                  rows={10}
                  onChange={(e) => setLyricsDraft(e.target.value)}
                  onKeyDown={(e) => {
                    const intent = lyricsKeyIntent(
                      { key: e.key, meta: e.metaKey || e.ctrlKey },
                      lyricsDirty,
                    );
                    if (intent === "save") {
                      e.preventDefault(); // ⌘S is ours, not the system's
                      void saveLyrics();
                    } else if (intent === "revert") {
                      e.stopPropagation(); // first Esc reverts, like tag fields
                      setLyricsDraft(null);
                    }
                  }}
                />
                <button
                  className="inspector-save"
                  onClick={() => void saveLyrics()}
                  disabled={!lyricsDirty || lyricsSaving}
                  data-tip="Writes the sidecar .lrc next to the audio file"
                >
                  {lyricsSaving ? "Saving…" : "Save lyrics"}
                </button>
              </>
            ))}
        </section>
      )}

      {single && (
        <dl className="inspector-analysis">
          <dt>BPM</dt>
          <dd>
            {single.bpm == null
              ? single.mix_analyzed
                ? "beatless"
                : "pending"
              : single.bpm_max != null
                ? `${Math.round(single.bpm)}–${Math.round(single.bpm_max)}`
                : `${Math.round(single.bpm)}`}
          </dd>
          <dt>Mix anchors</dt>
          <dd>
            {!single.mix_analyzed
              ? "pending"
              : [
                  single.mix_head_bpm != null ? "head" : null,
                  single.mix_tail_bpm != null ? "tail" : null,
                ]
                  .filter(Boolean)
                  .join(" + ") || "unstable"}
          </dd>
          {single.lyrics_offset_ms !== 0 && (
            <>
              <dt>Lyrics nudge</dt>
              <dd>{single.lyrics_offset_ms} ms</dd>
            </>
          )}
        </dl>
      )}

      <footer className="inspector-foot">
        <button className="inspector-save" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? "Saving…" : tracks.length > 1 ? `Save to ${tracks.length} tracks` : "Save"}
        </button>
        {dirty && (
          <code className="inspector-cli" data-tip="CLI equivalent — agents use this too">
            {buildCliCommand(
              tracks.length === 1 ? [tracks[0].path] : [`<${tracks.length} files>`],
              changes,
            )}
          </code>
        )}
      </footer>
    </aside>
  );
}
