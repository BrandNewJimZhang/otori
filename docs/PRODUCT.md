# Ōtori — Product Definition

> The design SSOT for *what* we build. ADR-0001 covers *how* it's built.

## Positioning

**Ōtori is the final stop for your local music files**: everything you
collect — doujin albums, BMS contest tracks, Vocaloid releases, rips —
gets organized into one clean, trustworthy library, then enjoyed in a
player with stage presence. And the organizing itself can be delegated
to an AI agent, safely.

Three promises: **organize** (tags/files), **enjoy** (spectrum/lyrics/
playback), **delegate** (agent-operable end to end).

## The user (concrete, not persona)

The founding user's library is the reference workload:

- ~1,200 tracks: 779 mp3 (working library) + 451 flac (masters), the
  mp3 tier partially transcoded from the flac tier — **same-track
  dual-format linking is a real need**.
- Heavily **hand-curated**: a personal classification scheme lives in
  filenames and title tags (`[Rhythm ...]`, `[Contest, BOF2013, 1st] …`).
  No online database knows this scheme. Any "normalize against
  MusicBrainz" pass that steamrolls it would destroy years of work.
- **ACG/doujin long tail**: BMS contest entries, Touhou arranges,
  M3/Reitaisai releases. MusicBrainz coverage is weak here; the
  VocaDB-family databases are the right sources (see Metadata
  providers). Agents must be humble: ask when unsure, never
  guess-and-write.
- Library lives in **iCloud Drive**. Defensive detail only, not a
  feature: scan skips `.icloud` placeholder files and reports them
  honestly (tags are unreadable without content; no "smart" handling,
  and never a mass download). Currently 0 evicted files in the
  reference library.
- The user already writes shell scripts (`cover.sh`, `m4a_to_mp3.sh`)
  for library chores — exactly the repetitive labor Ōtori's CLI
  replaces with a supported surface.

## Pillar 1: Agent-native (five-layer contract)

Most tools stop at layer 1 and call themselves agent-friendly. Ōtori
commits to all five:

### L1 — Interface (callable)
- `--json` on every subcommand; schemas stable and versioned
  (`otori --schema-version`), breaking changes follow semver.
- Semantic exit codes (0 ok / 2 partial / 3 bad input / 4 corrupt
  library); errors are structured JSON on stderr.
- The CLI is the only agent surface — no MCP server (ADR-0001 §3).
  Agents that speak shell already speak Ōtori.

### L2 — Safety (delegable) ★ the moat
The founding fear: *"the agent overrides tags I spent years curating."*
Undo alone cannot answer it — restoring after damage is weaker than
being untouchable. Three mechanisms, each owning one phase:

1. **Provenance (before)** — every tag field stores value + source +
   timestamp. Sources: `human` > `agent` > `import` > `inferred`.
   - Human-written fields are **curated: agents cannot overwrite them
     by default**. Skips are reported (`skipped: 37 fields (curated)`).
     Override requires `--override-curated`, and the dry-run diff
     renders those fields as loudly as possible.
   - Operations ranked by invasiveness: *fill empty* (default-allowed,
     the agent's main job) < *correct import/inferred values*
     (allowed, always in diff) < *overwrite curated* (default-denied).
   - `otori curate <filter>` bulk-marks existing values as curated —
     the onboarding oath that puts past labor under protection before
     any agent touches the library.
2. **Dry-run default (during)** — `--apply` is the flag, dry-run is
   the default. Output is a structured diff an agent can show a human.
   Renames/moves additionally require `--allow-rename`.
3. **Journal + first-touch snapshot (after)** — every `--apply` is a
   transaction; `otori undo <txid>` rolls back a whole batch. Before
   Ōtori's first-ever write to a file, its complete original tags are
   snapshotted: whatever happens later, "as first seen" is always
   recoverable.

### L3 — Observability (verifiable)
- The index is one SQLite file with a documented schema; agents may
  read it directly (read-only). Writes go through the CLI only.
- `otori status --json`: track count, missing-tag count, duplicate
  suspects, last scan time.
- Every transaction records who (GUI/CLI/agent id), when, what.

### L4 — Discoverability (self-teaching)
- `AGENTS.md` in the repo: command table, canonical workflows, schema
  docs. One file read = full tool fluency.
- `--help` includes a JSON output example per command.
- Canonical workflows ship as executable acceptance scripts — docs
  that cannot rot.

### L5 — Coexistence (human and agent, same library, same time)
- GUI observes index changes; when an agent fixes tags from the
  terminal, the UI updates live — watching the agent work is itself
  the product demo.
- Single-writer lock with clear errors; CLI and GUI never silently
  clobber each other.
- GUI batch operations display their CLI equivalent — the GUI teaches
  agents by example, and humans learn the automation surface for free.

## Pillar 2: Stage / Backstage dual-mode UI

Swinsian's aesthetic is a spreadsheet; listening deserves a stage.

- **Backstage**: dense tables, batch tag editing, filters — the
  director's desk. Information density wins.
- **Stage**: large art, live spectrum (lighting), synced lyrics
  (subtitles), minimal chrome — the performance. Immersion wins.
  - The spectrum is a **real-time bouncing bar analyzer tuned for
    electronic music** (the library is 400+ rhythm-game/hardcore
    tracks): log-frequency binning so kick/bass gets visual weight,
    dB scaling with a dynamic range that makes drops hit, peak-hold
    caps for percussive afterglow, 60fps canvas.
- One keystroke switches modes. Managing feels like Swinsian; pressing
  play starts a show.
- Visual identity: four accent colors (orange/pink/green/purple) map
  to the four functional areas (library/playback/lyrics/spectrum);
  `wonderhoy` ships as a built-in theme name, not the product name
  (see ADR-0001 §1).

## Lyrics: karaoke-grade, with a degradation ladder

Target is word-level karaoke highlighting (Apple Music grade), but the
library's doujin share makes full coverage impossible. Every rung is a
complete experience:

1. **Word-level** (enhanced LRC / qrc / yrc sources) — karaoke
   highlight.
2. **Line-level** (standard LRC, embedded SYLT/USLT or sidecar `.lrc`)
   — smooth scroll, current line centered.
3. **Static text** — full lyrics, no sync.
4. **None** — spectrum takes the whole stage.

Source priority: embedded tags → sidecar files → online providers
(pluggable; provider choice is a later decision). Fetched lyrics are
written as sidecars with provenance `agent`, never silently embedded.

## Metadata providers

Agent tag-fixing runs against a source matrix ordered by fit for this
library, not by general popularity:

1. **VocaDB** (Vocaloid: producer/vocalist/original-song relations,
   public REST API)
2. **TouhouDB** (Touhou arranges, including which ZUN original a track
   arranges — same open-source platform as VocaDB)
3. **VGMdb** (doujin albums, M3/Reitaisai/BMS releases)
4. **MusicBrainz** (fallback for everything else)

Provider answers are suggestions, never authority: they fill empty
fields and propose corrections through the L2 dry-run diff, and they
never touch curated fields.

## Competitive gap

| Player | Strength | Why it's not enough |
|---|---|---|
| Swinsian | light library mgmt + tag editing | stagnant; 2012 UI; no lyrics/viz; zero automation surface |
| Music.app | OS integration | hostile to file collectors; black-box library |
| Meta / Mp3tag | pro tag editing | an editor, not a player |
| foobar2000 (mac) | everything | second-class on mac; assembly required |
| Plexamp / Roon | gorgeous playback | server-heavy; read-only toward your tags |
| MusicBee | all-round | Windows only |

The vacant seat: **a Mac player where organizing and enjoying are one
app, the automation surface is first-class, and the safety model makes
delegation psychologically viable.** Features (tags/spectrum/lyrics)
are the entry ticket; the structural bets — the L2 trust stack and the
dual-mode UI — are what competitors can't bolt on.

## Non-goals (1.0)

- ❌ Streaming integration (Spotify/Apple Music — not your files).
- ❌ Music discovery/recommendation.
- ❌ Multi-device sync / server mode.
- ❌ Downloading music.
- ❌ Decrypting DRM/proprietary formats (e.g. `.ncm`) — legal gray
  zone, pollutes the positioning.

## MVP slicing

1. **Cut 1 — it plays**: scan (iCloud-aware) → SQLite index *with the
   provenance schema from day one* → track list → playback + live
   spectrum. Schema migrations cost 10× later; provenance is not
   deferrable.
2. **Cut 2 — it organizes**: tag read/write (lofty) + curate command +
   dry-run diff + journal/undo + first-touch snapshot. CLI reaches
   parity with GUI editing.
3. **Cut 3 — it performs**: Stage mode, LRC parsing + scroll,
   word-level where data exists. Smart playlists / watch folders.
