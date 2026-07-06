# Ōtori — Agent Guide

One read of this file = full tool fluency. The CLI (`otori`) is the
only agent surface; anything the GUI can do, you can do here.

## Ground rules (L2 trust stack)

1. **Dry-run is the default.** Every `set` prints a diff; nothing
   touches disk until `--apply`.
2. **Always pass `--agent <your-id>`.** It journals who acted, and it
   activates curated-field protection. Omitting it impersonates the
   human — never do that.
3. **Curated fields bounce you.** Values a human wrote (or blessed via
   `otori curate`) are protected: your change is skipped and reported.
   You may *propose* — show the human the skip report — but never
   pass `--override-curated` without an explicit human instruction in
   the current conversation.
4. **When unsure, ask.** This library's doujin/ACG long tail is poorly
   covered by online databases; the owner's personal classification
   scheme (`[Rhythm Game, プロセカ] …`, `[Contest, BOF2013, 1st] …`)
   looks nonstandard but is intentional. Never "normalize" it.
5. **Every `--apply` is undoable**: note the printed transaction id;
   `otori undo <txid>` rolls the whole batch back (file + index +
   provenance).

## Commands

| Command | What it does | Notes |
|---|---|---|
| `otori scan <dir> [--json]` | Index a folder recursively | exit 2 if files were iCloud-skipped or unreadable |
| `otori list [--json]` | List indexed tracks | ordered artist → title |
| `otori tags <file>` | Read tags straight from a file | bypasses the index |
| `otori lyrics <file> [--json]` | Lyrics: embedded tag, then sidecar `.lrc` | JSON includes sync kind (`word_synced`/`line_synced`/`static`) |
| `otori set <file> --title/--artist/--album <v> [--agent <id>] [--apply] [--override-curated] [--json]` | Edit tags | dry-run without `--apply`; exit 2 when curated fields were skipped |
| `otori curate <file>` / `otori curate --all` | Mark existing values as protected | the onboarding oath |
| `otori undo <txid>` | Roll back an applied transaction | fails if already undone |
| `otori journal [--json]` | List applied transactions | newest first |
| `otori status [--json]` | Vital signs: counts, completeness, curation coverage, journal | start here to orient |
| `otori schema-version` | CLI JSON schema version | breaking JSON changes bump it; additive fields do not — tolerate unknown fields |
| `--db <path>` (global) | Use a specific library db | default: `~/Library/Application Support/otori/library.db` |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | full success |
| 2 | partial: curated fields skipped, or scan had skipped/unreadable files |
| 3 | bad input (path, field, arguments) |
| 4 | library unopenable or corrupt |

Errors are structured JSON on stderr: `{"error": "...", "kind": "..."}`.

## Canonical workflows

Fill missing albums for one file (safe: fill-empty is your job):

```bash
otori set song.mp3 --album "Album Name" --agent myname --apply
```

Propose a correction to a curated field (do NOT apply):

```bash
otori set song.mp3 --title "Corrected" --agent myname
# → SKIPPED (curated) title: ... — proposed: Corrected
# Relay this to the human; only they decide.
```

Inspect state before acting:

```bash
otori list --json | jq '.[] | select(.album == null)'   # tracks missing albums
otori journal --json                                     # what happened before you
```

The index SQLite schema is readable directly (read-only!) at the
`--db` path; writes go through the CLI only.

## This file cannot rot

Every workflow above is exercised by `scripts/acceptance.sh` (run it
with `cargo build -p otori-cli && scripts/acceptance.sh`). If this doc
and the binary disagree, the script fails — trust the script, then fix
whichever side is wrong.

## Coexistence with the GUI

The desktop app watches the library via SQLite `data_version` polling
and emits a `library-changed` Tauri event (no payload) whenever another
connection — you, through the CLI — commits. You don't need to notify
anyone after `--apply`: a running GUI refreshes itself within ~1s.
