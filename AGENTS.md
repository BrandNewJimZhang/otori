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
   provenance). Belt and suspenders: every `--apply` and `undo` also
   snapshots the library db into `<db-dir>/backups/` first (newest
   10 kept) — the trust layer is the one thing that cannot be rebuilt
   from files, so it is backed up before anything touches it.

## Commands

| Command | What it does | Notes |
|---|---|---|
| `otori scan <dir> [--json]` | Index a folder recursively | exit 2 if files were iCloud-skipped or unreadable |
| `otori list [--json]` | List indexed tracks | ordered artist → title |
| `otori tags <file>` | Read tags straight from a file | bypasses the index |
| `otori lyrics <file> [--json]` | Lyrics: embedded tag, then sidecar `.lrc` | JSON includes sync kind (`word_synced`/`line_synced`/`static`) |
| `otori artwork <file> [--out <img>] [--min-size <px>] [--json]` | Locate cover art: embedded → sidecar image → folder cover | exit 2 if the shorter side is under `--min-size` (default 500px) or dimensions are unverifiable |
| `otori backup [dest] [--json]` | Snapshot the library db | default: timestamped file in `<db-dir>/backups/`; never overwrites |
| `otori jacket <file> [--apply] [--min-size <px>] [--json]` | Fetch a jacket from VocaDB → sidecar | dry-run by default; refuses when art exists; exit 2 on no-match (then fall back to the wiki workflow) |
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

## Canonical workflow: fetching jackets

The library's text tags are complete; the recurring agent job is
finding cover art (jackets), especially for rhythm-game tracks
(`[Rhythm Game, <game>] …` titles — 400+ tracks). Delivery is a
sidecar image, never a tag write:

```bash
# 1. Which tracks lack any artwork?
otori list --json | jq -r '.[].path' | while read -r f; do
  [ "$(otori artwork "$f" --json)" = "null" ] && echo "$f"
done

# 2. Vocaloid/Touhou tracks: try the API provider first —
#    it matches by exact title (incl. aliases) + artist and
#    enforces the resolution floor automatically:
otori jacket "/path/to/[Vocaloid] song.mp3" --apply
#    exit 2 (no match / no album art / VocaDB cover below floor)
#    → fall back to the wiki workflow below.

# 3. Rhythm-game tracks: identify the source from the title's game
#    marker, fetch the jacket from the wiki (table below), save it
#    next to the file:
#    "/path/to/[Rhythm Game, Arcaea] Tempestissimo.mp3"
#    → "/path/to/[Rhythm Game, Arcaea] Tempestissimo.jpg"

# 4. Verify pickup and the floor (source: "sidecar", below_min_size: false):
otori artwork "/path/to/track.mp3" --json
```

A running GUI shows the new jacket on next play — no notification
needed. Wrong image? Delete the sidecar; the chain falls back.

### Per-game jacket sources

| Game marker | Source |
|---|---|
| maimai / maimai DX / Chunithm / オンゲキ | SilentBlue.RED (JP wiki, covers all SEGA arcade titles) |
| プロセカ | Sekaipedia / プロセカ攻略 wiki (wikiwiki.jp) |
| Arcaea | Arcaea Fandom wiki |
| WACCA / Muse Dash / Phigros / Lanota / Dynamix / Rotaeno | per-game Fandom or wikiwiki.jp community wiki |
| IIDX / Sound Voltex / jubeat / REFLEC BEAT | RemyWiki (KONAMI standard source) |
| osu! family | osu! official song listing / beatmap pages |
| anything unlisted | search "<game> wiki <song title>"; wikiwiki.jp hosts many JP game wikis |

Rules of engagement: match by exact song title AND artist (rhythm
games love same-name covers); **the resolution floor is 500px on the
shorter side** — after saving a sidecar, run
`otori artwork <file> --json` and treat `below_min_size: true`
(exit 2) as failure: find a larger image or report the gap, never
leave a low-res jacket in place; when the wiki shows several versions
(original vs game edit), pick the one matching the track's `[…]`
marker; **unsure = ask, never guess** — a wrong jacket on the Stage
is worse than none.

### Text-tag sources (structured APIs, for the non-game tiers)

Vocaloid → VocaDB · Touhou arranges → TouhouDB · doujin albums →
VGMdb · fallback → MusicBrainz. Corrections flow through the normal
`set --agent` dry-run diff; curated fields stay untouchable.

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
