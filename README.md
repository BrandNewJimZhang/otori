# Ōtori

A music player that treats your library with respect — Swinsian-grade tag
management, live spectrum visualization, and synced scrolling lyrics.

Named after 鳳 (ōtori, the phoenix). Also reads as 音鳥 — the bird of sound.

## Architecture

```
otori/
├── crates/
│   ├── otori-core/   # engine room: library index, tag r/w, lyrics parsing (Rust)
│   └── otori-cli/    # `otori` binary — the agent-facing surface (Rust)
├── src-tauri/        # desktop shell: thin IPC glue over otori-core (Rust)
└── src/              # everything you see: UI, playback, spectrum, lyrics (TypeScript)
```

Two consumers, one core. The GUI (for humans) and the CLI (for agents and
scripts) are both thin layers over `otori-core`; anything one can do, the
other can do.

### CLI contract

- `--json` on every subcommand, stable schema
- destructive operations are `--dry-run` by default and print the diff first
- semantic exit codes; structured errors on stderr

## Development

```bash
pnpm install
pnpm tauri dev        # desktop app
cargo run -p otori-cli -- tags <file>   # CLI
```

## Status

Pre-alpha. See `docs/adr/` for design decisions.
