# Design: Backstage tag inspector

Date: 2026-07-07
Status: approved design, not yet implemented
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

- Docked right column in Backstage (~300px), toggled by `i` (free in
  `uikeys.ts`) and View menu. The up-next queue panel is an overlay
  popover, so no rail conflict.
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
