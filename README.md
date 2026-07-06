# Ōtori

**The final stop for your local music files.**

Everything you collect — doujin albums, BMS contest tracks, Vocaloid
releases, rips — gets organized into one clean, trustworthy library,
then enjoyed in a player with stage presence. And the organizing itself
can be delegated to an AI agent, *safely*.

Named after 鳳 (ōtori, the phoenix). Also reads as 音鳥 — the bird of
sound.

> Pre-alpha. macOS-first. Building in the open (of this private repo).

## Why another music player?

Every existing tool makes you choose: organize *or* enjoy *or*
automate. Swinsian manages but doesn't perform; Music.app is hostile to
file collectors; Mp3tag edits but doesn't play; Plexamp plays
beautifully but treats your tags as read-only. None of them gives an AI
agent a real seat at the table.

Ōtori's three promises:

1. **Organize** — Swinsian-grade tag management over your actual files,
   with a personal-curation-aware safety model.
2. **Enjoy** — a Stage mode with live spectrum analysis tuned for
   electronic music, and karaoke-grade synced lyrics where data exists.
3. **Delegate** — the entire feature surface is agent-operable through
   a CLI contract, and delegation is psychologically viable because the
   safety model makes your curated work untouchable by default.

## The two structural bets

### Agent-native, with a trust stack

Most "agent-friendly" tools stop at machine-readable output. Ōtori
commits to a five-layer contract (interface / safety / observability /
discoverability / coexistence — see [docs/PRODUCT.md](docs/PRODUCT.md)),
and the safety layer is the moat:

- **Provenance, first-class**: every tag field records its source —
  `human` > `agent` > `import` > `inferred`. Human-curated fields are
  untouchable by agents unless you explicitly override.
- **Dry-run by default**: destructive operations print a structured
  diff; `--apply` is the flag, not the default.
- **Journal + first-touch snapshot**: every applied batch is an
  undoable transaction, and a file's original tags are snapshotted
  before Ōtori's first-ever write to it.

*Provenance before, dry-run during, undo after.* Restoring after damage
is weaker than being untouchable.

### Stage / Backstage dual-mode UI

Managing a library and enjoying it are different postures:

- **Backstage** — dense tables, batch tag editing, filters. Information
  density wins.
- **Stage** — large art, real-time spectrum bars (log-frequency,
  dB-scaled, peak-hold, 60fps), synced scrolling lyrics, minimal
  chrome. Immersion wins.

One keystroke switches. Managing feels like Swinsian; pressing play
starts a show.

## Architecture

```
otori/
├── crates/
│   ├── otori-core/   # engine room: library index (SQLite), tag r/w, lyrics parsing (Rust)
│   └── otori-cli/    # `otori` binary — the agent-facing surface (Rust)
├── src-tauri/        # desktop shell: thin IPC glue over otori-core (Rust)
└── src/              # everything you see: UI, playback, spectrum, lyrics (TypeScript)
```

Two consumers, one core. The GUI (for humans) and the CLI (for agents
and scripts) are both thin layers over `otori-core`; anything one can
do, the other can do. The CLI is the *only* agent surface — agents that
speak shell already speak Ōtori.

### CLI contract

- `--json` on every subcommand, stable versioned schemas
- destructive operations are dry-run by default and print the diff
  first; `--apply` makes it real
- semantic exit codes (0 ok / 2 partial / 3 bad input / 4 corrupt
  library); structured errors on stderr
- the SQLite index schema is documented and open for reads; writes go
  through the CLI only

## Development

```bash
pnpm install
pnpm tauri dev                          # desktop app
cargo run -p otori-cli -- tags <file>   # CLI
pnpm tauri build --bundles app          # package .app
```

Stack: Tauri 2 · Rust (lofty, symphonia) · Vite · React 19 ·
TypeScript.

## Roadmap (MVP cuts)

1. **It plays** — iCloud-aware scan → SQLite index *with the provenance
   schema from day one* → track list → playback + live spectrum.
2. **It organizes** — tag read/write, `otori curate`, dry-run diffs,
   journal/undo, first-touch snapshots. CLI reaches parity with GUI
   editing.
3. **It performs** — Stage mode, LRC parsing + scroll, word-level
   lyrics where data exists. Smart playlists, watch folders.

Non-goals for 1.0: streaming integration, recommendations, multi-device
sync, downloading, DRM decryption.

## Design docs

- [docs/PRODUCT.md](docs/PRODUCT.md) — what we build and why (the
  design SSOT)
- [docs/adr/](docs/adr/) — architecture decision records
