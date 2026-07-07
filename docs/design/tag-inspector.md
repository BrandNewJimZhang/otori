# Design: Backstage tag inspector

Date: 2026-07-07
Status: v1 shipped (817c4c1); r2 amendment below approved 2026-07-07
Authorized by: ADR-0001 amendment A5

The human-facing counterpart of the agent-facing `otori set`: a
Swinsian-style right-side panel in Backstage that shows the selected
track's tags *and their trust state*, and edits them through the same
core write path agents use. Editing a field here is the oath — the
value becomes `human`-sourced and born curated.

## What it is NOT

- Not a generic metadata browser: v1 shows exactly the fields the
  index knows (title/artist/album writable; identity/analysis facts
  read-only). The panel grows with the query surface, never ahead of
  it (same rule as `write.rs::WRITABLE_FIELDS`).
- Not a second write path: the frontend never touches files. One IPC
  command wraps `otori_core::write`, or the moat leaks.
- Not the agent-proposal review UI. Advisory diffs ("agent proposes a
  fix to a curated field") need proposal storage that doesn't exist
  yet; separate design when it does.

## Layout & interaction

- Docked right column in Backstage (~300px), toggled by `⌘I` (mac
  "Get Info" convention; plain `i` stays type-ahead — amended from the
  original `i` during implementation) and View menu. The up-next queue
  panel is an overlay popover, so no rail conflict.
- Selection drives content: 0 selected = empty-state hint; 1 = full
  panel; N = batch mode (below).
- Sections, top to bottom:
  1. **Artwork + identity** — thumbnail (`getArtwork`), filename,
     format · duration · ReplayGain, full path (click = reveal in
     Finder). Read-only.
  2. **Tags** — title / artist / album as text inputs. Per field:
     - **source badge**: `human` / `agent` / `import` / `inferred`,
       color-coded; `curated` adds a lock glyph. This is the first
       time the index's trust layer (provenance) is visible anywhere.
     - dirty state: edited-but-unsaved fields render distinctly;
       Enter or "Save" commits, Escape reverts the focused field.
  3. **Analysis** — BPM (+ range, confidence, `bpm_source`), mix
     anchors present/absent, lyrics offset. Read-only here (the
     sweeper owns these columns; hand-editing BPM is a non-goal).
  4. **CLI footer** — after every save, show the equivalent command:
     `otori set "<path>" --title "…" --apply`
     (L5: the GUI teaches the automation surface by example). Click
     to copy.
- Focus contract: panel inputs are a `zone` like the existing table —
  type-ahead and transport keys must not fire while editing; Escape
  walks input → panel → closed.

## Batch mode (N selected)

- Fields where all N agree show the value; disagreeing fields show a
  `⟨multiple⟩` placeholder (standard Swinsian/Mp3tag semantics).
- Only fields the user actually edits are written; `⟨multiple⟩` left
  untouched writes nothing.
- One save = **one journal transaction** covering all N files, so
  `otori undo <txid>` rolls back the whole batch — PRODUCT.md already
  promises batch-undo, and per-file transactions would break it.
  Requires the core change below.

## Core & IPC changes

### 1. Hoist auto-backup into core (prerequisite, fixes a latent hole)

"No backup, no mutation" currently lives in the CLI
(`main.rs::auto_backup`) — a GUI IPC call would bypass it, violating
ADR-0001's "tag write safety is a core-level invariant, not a GUI
feature". Move the call into `write::apply_set` itself (backup once
per apply, before the transaction opens). CLI drops its wrapper; both
consumers become incapable of skipping it.

### 2. Batch transaction in core

Extend `write.rs` with a multi-track apply (one `transactions` row,
per-file first-touch snapshots, disk-first per file inside the one db
transaction; any file failure rolls back the whole batch). Single-file
`apply_set` becomes the N=1 case. CLI `set` keeps its one-path
signature for now.

### 3. Read side: provenance query

New `query.rs` function returning per-field trust for one track:

```
{ field, value, source, curated, written_by, written_at }[]
```

`tag_values` already stores all of it; this is a SELECT, not schema.

### 4. IPC commands (`src-tauri` → `ipc.ts`)

- `get_tag_provenance(trackId)` → the rows above.
- `set_tags(paths: string[], changes: FieldChange[])` →
  `apply_set` with `Actor::Human { via: "gui" }`, returns
  `{ txId, applied: PlannedChange[] }`. No dry-run round-trip in v1:
  a human typing into a form *is* the review step; the dry-run
  default is an agent-safety mechanism, not a human-friction
  requirement. (If batch mode later feels risky, add a confirm sheet
  fed by `plan_set` — the core API already supports it.)
- After apply, the shell emits the existing `library-changed` event —
  the table and any second window refresh through the pipe that
  already serves the CLI-writes-GUI-watches demo (L5).

### 5. Frontend

- `types.ts`: mirror `TagProvenance`; `ipc.ts`: the two calls.
- `inspector.ts` — pure logic, TDD like every sibling module:
  merge N tracks into display values (`agree` / `multiple` / `empty`),
  dirty-diff (edited fields → `FieldChange[]`, placeholders dropped),
  CLI-string builder (quoting!). Component (`Inspector.tsx`) stays a
  thin renderer over it.

## Provenance display vocabulary

| source     | badge | meaning                                  |
|------------|-------|------------------------------------------|
| human      | 🔒 H  | edited in Ōtori by a person; curated     |
| agent      | A     | written by an agent via CLI              |
| import     | I     | pre-existing / external-editor value     |
| inferred   | ?     | guessed (filename parse etc.)            |

`curated` on a non-human source (via `otori curate`) shows the lock
without changing the letter.

## Test plan (TDD order)

1. `inspector.test.ts`: merge/diff/CLI-string pure functions first.
2. `write.rs` tests: batch apply = one tx id; undo restores all files;
   auto-backup fires before mutation (backup file exists even when the
   disk write fails).
3. Acceptance: edit title in GUI → `otori tags <path>` shows it,
   journal actor is `gui`, field is curated; then `otori set --agent x`
   on the same field reports `skipped (curated)`.

## Open questions (non-blocking)

- Reveal-in-Finder needs a Tauri opener capability — check allowlist.
- Single-writer lock: GUI holds a long-lived connection; verify a
  concurrent CLI `--apply` surfaces the promised "clear error" rather
  than SQLITE_BUSY jank (busy_timeout + one retry is acceptable).

---

# r2 amendment: entry points, cover removal, lyrics editing

Date: 2026-07-07. Three gaps found in v1 use: the panel is
undiscoverable, the cover is display-only, and lyrics text is
invisible in Backstage. All three stay inside the v1 doctrine — one
core write path, files as SSOT for values.

## 1. Entry points

v1 reality: `⌘I` and an accelerator-less View-menu item are the only
ways in; the row context menu — the natural "act on this track"
surface — has no inspector entry, and the toolbar shows nothing.

- **Context menu**: add "Get Info" (single) / "Get Info on N tracks"
  (batch) as the first item after Play. Action = select the clicked
  target(s) (already contextTargets semantics) + `setInspectorOpen(true)`.
  Not a toggle: a menu that says "Get Info" must never close the panel.
- **Toolbar**: an `icon-btn` inspector toggle next to the Stage toggle,
  `aria-pressed` + tip "Inspector (⌘I)" — the shortcut teaches itself,
  same pattern as "Stage (S)".
- No change to `⌘I` or the View menu.

## 2. Cover removal (single-track)

The inspector thumbnail is the only place a wrong/ugly embedded cover
is visible up close — it is where removal belongs.

- **Scope**: removes the *embedded* picture only. Sidecar/folder art is
  files-on-disk (deleting user files is Finder's job, not a tag
  operation); after removal the resolve chain simply falls back to
  them, which the refreshed thumbnail shows immediately.
- **UI**: hovering the thumbnail reveals a small "Remove cover" action;
  shown only when the resolved art source is `embedded` (needs
  `get_artwork` to also return the source — extend the IPC payload to
  `{ dataUrl, source }`).
- **Core**: `write::remove_artwork(conn, path, actor)` — mirror of
  `embed_artwork`: refuses when nothing is embedded, full L2 (db
  auto-backup, first-touch snapshot, one-transaction journal row
  `field='picture', old_value=<source>, new_value=NULL`).
- **Undo asymmetry is explicit**: the journal stores provenance, not
  bytes, so `otori undo` of a removal CANNOT restore the picture
  (same reason `("picture", Some(_))` errors today). `undo` on such a
  tx must fail with a clear message pointing at the first-touch
  snapshot/backups. The GUI toast therefore says "Cover removed" with
  NO undo handle — silence about undo is the honest UI here.
- **IPC**: `remove_artwork(path) -> txId`, emits `library-changed`.
  CLI twin `otori remove-artwork <path> --apply` can follow later; the
  core function is the shared seam (not blocking this cut).

## 3. Lyrics editing (single-track)

Editing lyrics text is a Backstage/inspector concern (fixing a typo,
pasting lyrics in); Stage stays a pure renderer.

- **Scope**: the **sidecar `.lrc` is the only editable surface.**
  Embedded lyrics tags stay read-only in r2 (no USLT writer exists in
  core, and the sidecar-first delivery rule is PRODUCT.md doctrine).
  Since embedded wins in `resolve()`, a track with an embedded tag
  shows its lyrics as read-only with a note; sidecar-or-none tracks
  get the editor.
- **UI**: a "Lyrics" section between Tags and Analysis, single-track
  only. Collapsed by default to a one-line summary (kind · source ·
  line count, or "No lyrics"); expands to a monospace textarea holding
  the raw LRC text. Save button per section (lyrics are not tag
  fields; they do not ride the tag Save/journal path). Escape reverts,
  same dirty-state affordance as tag fields.
- **Core**: `lyrics::write_sidecar` keeps `create_new` for the agent
  path. New `lyrics::overwrite_sidecar(audio, lrc_text) -> PathBuf`
  is the human path — the "replacing lyrics is a human decision"
  comment already reserves exactly this seam. No `[by:]` header
  injection: the human owns the full text verbatim. Empty text is a
  bad call, not a delete — refuse (removal is r3 scope if wanted).
- **Raw read**: the editor needs the raw sidecar text, not the parsed
  `LyricsDoc`. New `lyrics::read_raw(audio) -> Option<(source, text)>`
  (embedded tag string or sidecar file contents), IPC
  `get_lyrics_raw(path)`.
- **Not journaled**: sidecars are not audio-file tag writes; they are
  the same class as agent-delivered `.lrc` files today (undo = edit
  again). No first-touch snapshot, no tx row. If lyrics ever move
  into tags, they enter the journal then.
- After save: emit nothing — lyrics are read per-track on play; the
  inspector re-reads its own section. (`library-changed` would refetch
  the whole table for a text file no column displays.)

## r2 test plan (TDD order)

1. `lyrics.rs` tests: `overwrite_sidecar` replaces existing content /
   creates when absent / refuses empty text; `read_raw` returns
   sidecar text, embedded text, or None.
2. `embed.rs` tests: `remove_artwork` strips the picture (resolve
   falls back to sidecar), journals `picture: <source> → NULL`,
   refuses when nothing embedded, undo of a removal fails with the
   snapshot-pointing message.
3. `inspector.test.ts`: lyrics-section state machine (readonly vs
   editable vs empty by source) and cover-action visibility (embedded
   only) as pure functions.
4. Acceptance: remove a cover in the GUI → thumbnail falls back to
   sidecar art; edit lyrics → Stage shows the new text on next play.
