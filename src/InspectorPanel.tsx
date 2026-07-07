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
  getTagProvenance,
  setTags,
  type TagProvenance,
  type WritableField,
} from "./ipc";
import {
  buildCliCommand,
  diffEdits,
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

export function InspectorPanel({ tracks, onClose, onSaved, onError }: Props) {
  const single = tracks.length === 1 ? tracks[0] : null;
  const merged = mergeTracks(tracks);
  const [edits, setEdits] = useState<FieldEdits>(noEdits);
  const [saving, setSaving] = useState(false);
  const [artwork, setArtwork] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<TagProvenance[]>([]);
  // Selection identity: switching rows discards unsaved edits (the
  // inputs are previews of the selection, not a persistent form).
  const selectionKey = tracks.map((t) => t.id).join(",");
  useEffect(() => {
    setEdits(noEdits);
  }, [selectionKey]);

  // Artwork + provenance are single-track affordances; batch mode
  // shows neither (whose cover would it be?).
  useEffect(() => {
    let stale = false;
    setArtwork(null);
    setProvenance([]);
    if (!single) return;
    getArtwork(single.path).then((a) => !stale && setArtwork(a)).catch(() => {});
    getTagProvenance(single.id)
      .then((p) => !stale && setProvenance(p))
      .catch(() => {}); // badge-less fields degrade gracefully
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
            <img className="inspector-art" src={artwork} alt="" />
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
