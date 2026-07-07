# ADR-0002: First release at v0.1.0, not 1.0.0

Date: 2026-07-07
Status: accepted

## Context

The project's first release was approaching. The question on the table
was whether to cut it as `1.0.0` or `0.1.0`.

`1.0.0` in semver is a *promise*: it tells consumers — here, both human
users and AI agents driving the CLI contract — that the public surface
is frozen and that breaking changes require a major bump. Ōtori's
distinctive feature is that the CLI is an agent contract (AGENTS.md:
JSON schemas, exit codes, dry-run semantics), so a 1.0 carries more
weight here than for a plain GUI player.

Five concrete observations argued against 1.0 at this point:

1. **The schema is still in flux.** `SCHEMA_VERSION = 13` in
   `crates/otori-core/src/db.rs`, and the most recent migration
   (`efc9c7f`, v13) reopened *every* track's BPM/mix analysis to swap
   the detection engine to Beat This! (`otori-analysis`). Reopening the
   whole library's results for an engine change is not fine-tuning; it
   is the kind of churn a frozen 1.0 forbids.
2. **The README self-contradicts a 1.0.** It states "Pre-alpha. APIs,
   schemas, and UI are all still moving." That sentence and a 1.0 tag
   cannot both be true.
3. **The MVP is incomplete.** Roadmap cut #3 ("It performs" — Stage
   mode, synced lyrics, smart playlists, watch folders) is still ◐;
   smart playlists and watch folders are unbuilt.
4. **Delivery maturity.** macOS-only, no CI on PRs, and unsigned builds.
   1.0 implies general usability; an unsigned `.dmg` that Gatekeeper
   blocks on first open does not meet that bar.
5. **Test coverage of the contract.** The local ship gate
   (`autoskill.yml`) runs `otori-core` + `tsc` + `vitest`, but does not
   run `otori-analysis`, `otori-cli`'s tests, or `scripts/acceptance.sh`
   (the L4 contract test that fails if AGENTS.md drifts from the
   binary). Releasing a 1.0 contract without the contract test in the
   default gate is premature.

The design itself — the trust stack, provenance, dry-run-by-default,
journal/undo, Stage/Backstage, the CLI-as-agent-contract — is sound.
This decision is about *release maturity*, not design quality.

## Decision

Cut the first release as **`v0.1.0`**.

`1.0.0` is deferred until the bar in
[CONTRIBUTING.md § "Reaching 1.0"](../../CONTRIBUTING.md) holds:

- schema freeze (no engine-swap library reopen; CLI JSON additive-only),
- roadmap #3 lands or is explicitly scoped out,
- signed + notarized macOS build (Developer ID),
- CI gate on PRs including `acceptance.sh`,
- AGENTS.md contract stable for a release cycle.

Until then, breaking changes between `0.x` releases are expected and
need no deprecation cycle.

### Code signing

The `0.1.0` build is **unsigned** (ad-hoc only). macOS Gatekeeper
blocks an unnotarized download on first open; users strip the quarantine
flag (`xattr -dr com.apple.quarantine`) or right-click → Open. This is
an explicit, recorded choice for pre-alpha, not an oversight:

- A Developer ID + notarization costs ~$99/yr (Apple Developer Program).
  It buys *installation smoothness*, not the ability to publish —
  GitHub Releases accepts unsigned `.dmg` files regardless.
- At pre-alpha scale the cost is not yet justified; the 1.0 bar brings
  it in scope.

## Consequences

- Version `0.1.0` is the floor: "first usable cut, expect breakage."
- The `0.x` → `1.0` transition is gated by the CONTRIBUTING.md bar, not
  by a date.
- Future `0.x` schema bumps (e.g. another detection-engine change) are
  allowed and do not violate a contract promise — but each one pushes
  1.0 further out, which is the correct pressure.
- The version number lives in three places that must stay in sync:
  `package.json`, `src-tauri/tauri.conf.json`, and the workspace
  `version` in `Cargo.toml` (inherited by all crates). Bumps touch all
  three.
