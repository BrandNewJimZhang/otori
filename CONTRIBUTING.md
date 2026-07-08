# Contributing to Ōtori

Thanks for your interest! Ōtori is pre-alpha and moving fast, so the
most valuable contributions right now are bug reports with real-world
files, and focused PRs that respect the design constraints below.

## Before you start

- Read [docs/PRODUCT.md](docs/PRODUCT.md) — it is the design SSOT.
  PRs that fight the product decisions recorded there will be asked to
  restate the case as an issue first.
- Check [AGENTS.md](AGENTS.md) if your change touches the CLI: the CLI
  is a *contract* (JSON schemas, exit codes, dry-run semantics), not
  just a binary. Contract changes need the doc updated in the same PR.

## Dev setup

Prerequisites: [Rust](https://rustup.rs/) (stable), Node.js +
[pnpm](https://pnpm.io/), and the
[Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/).
On Linux that is `libwebkit2gtk-4.1-dev libssl-dev
libayatana-appindicator3-dev librsvg2-dev libxdo-dev` plus
build-essential; macOS and Windows need nothing beyond the language
toolchains.

```bash
pnpm install
pnpm tauri dev            # run the desktop app
cargo build -p otori-cli  # build the CLI
```

## Tests

- **Rust core**: `cargo test -p otori-core` — integration tests live
  in `crates/otori-core/tests/`, one file per module.
- **CLI acceptance**: `cargo build -p otori-cli && scripts/acceptance.sh`
  — verifies the CLI contract against AGENTS.md. If they disagree, the
  script fails; trust the script, then fix whichever side is wrong.
- **Frontend**: `pnpm vitest run` — tests are `*.test.ts` next to the
  module they cover under `src/`.

Every behavior change needs test coverage. Write the failing test
first; a PR whose tests pass on the pre-change code isn't testing the
change.

## Design constraints worth knowing

A few rules that shape what gets merged:

- **Files are the SSOT for tag values; the database is the SSOT for
  trust.** Never write tag values only to the index, and never store
  trust state (provenance, curation, journal) only in files.
- **Provenance is load-bearing.** Any new write path must record a
  source (`human` / `agent` / `import` / `inferred`) and respect
  curated-field protection.
- **Destructive operations are dry-run by default.** `--apply` makes
  it real; the dry run prints the exact diff.
- **External metadata is a hint, never a result.** Provider values
  (BPM, etc.) anchor verification; the built-in detector owns the
  final column.
- **Fail fast.** Corrupt library state raises with the offending path;
  it is never smoothed over into an empty result.

## Commit & PR conventions

- Commit titles: English, imperative, ≤72 chars, prefixed
  `Feat:` / `Fix:` / `Refactor:` / `Docs:` / `Test:` / `Chore:` /
  `Perf:` / `Style:`. Body explains what changed and why.
- One objective per commit; keep PRs focused — structural refactors
  and feature changes in separate commits.
- Linear history: rebase on `main`, no merge commits.

## Metadata providers

Built-in providers are limited to services with public, documented,
scrape-free APIs (currently VocaDB and LRCLIB). PRs adding scrapers or
providers whose terms of service prohibit automated access will be
declined — `otori import-bpm` exists precisely so such data can enter
the library as an explicit, provenance-tracked *import* instead of a
built-in.

## Reaching 1.0

Ōtori is pre-alpha (v0.1.0). `1.0.0` is a *promise* — it tells human
users and agent consumers that the public contract is frozen and that
breaking changes go through a major bump. The bar (all must hold):

- **Schema freeze.** The library schema (`SCHEMA_VERSION` in
  `crates/otori-core/src/db.rs`) is stable; no engine swap reopens the
  whole library's analysis. The CLI JSON contract enters
  additive-only (`otori --schema-version`; new fields allowed, breaking
  changes require a bump).
- **Roadmap #3 lands.** "It performs" reaches ✅, or its remaining
  pieces (smart playlists, watch folders) are explicitly scoped out of
  1.0 and recorded here.
- **Signed + notarized macOS build, and a signed Windows build.**
  Developer ID signing + notarization so a downloaded `.dmg` opens
  without Gatekeeper intervention (~$99/yr Apple Developer Program,
  deferred from 0.1.0), and Authenticode signing so the Windows build
  clears SmartScreen (deferred with the macOS signing). Linux artifacts
  (`.deb`/`.AppImage`) stay unsigned, like the macOS pre-alpha.
- **CI gate on PRs.** The full test suite — `cargo test --workspace`,
  `scripts/acceptance.sh` (the AGENTS.md contract), `tsc --noEmit`,
  `vitest run` — runs on every PR on macOS, Linux, and Windows, not just
  the local ship gate.
- **AGENTS.md contract stable for a release cycle** with no edits.

Until then, breaking changes between `0.x` releases are expected and do
not require a deprecation cycle. The current ship gate
(`autoskill.yml`) covers `otori-core` + `tsc` + `vitest`; the release
gate additionally runs `cargo test --workspace` and
`scripts/acceptance.sh`.

## License of contributions

Ōtori is licensed under [AGPL-3.0-only](LICENSE). By submitting a
contribution, you agree that it is licensed under the same terms.
