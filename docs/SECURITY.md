# Security posture (pre-alpha)

Ōtori is a local-first desktop music player. This note records the
security tradeoffs in the `0.1.0` build and the hardening planned for
1.0. It is *not* a vulnerability disclosure channel — for that, see the
GitHub Issues / Security tab.

## Threat model

The app runs locally, reads audio files the user points it at, writes
tags to those files, and talks to two public metadata APIs (VocaDB,
LRCLIB). There is no server component and no remote playback surface.
The attacker model is "a malicious audio file or metadata response the
app parses," not network intrusion.

## Current tradeoffs (v0.1.0)

### Content Security Policy is disabled (`csp: null`)

`src-tauri/tauri.conf.json` ships with `app.security.csp: null`. A
strict CSP would be defense-in-depth against an XSS escape. The
exposure is assessed as low for `0.1.0`:

- The frontend renders no untrusted HTML. There is no
  `dangerouslySetInnerHTML`, no `innerHTML`/`insertAdjacentHTML`
  injection of provider or file-derived text. Lyrics, tags, and
  filenames render as React text children (auto-escaped).
- The two network providers return JSON consumed as data, never as
  markup.

This is a *recorded* pre-alpha simplification, not an oversight. The
1.0 hardening (below) tightens it.

### Asset protocol scope is `$HOME/**`

`assetProtocol.scope: ["$HOME/**"]` lets the WebView load any file
under the user's home as an audio source / cover image. This is
required: a music player must play files wherever the user keeps them,
and macOS music libraries live under `$HOME`. The scope is the
narrowest that still serves the product. It is not tightened to a
single music folder because Ōtori is explicitly multi-root
(`otori scan` on arbitrary dirs).

### Unsigned, unnotarized build

The `.dmg` is ad-hoc signed only. macOS Gatekeeper blocks a fresh
download on first open; users bypass with `xattr -dr` or right-click →
Open. See [README § "Installing the pre-alpha
build"](../README.md#installing-the-pre-alpha-build). This is a
cost/scale decision (Developer ID is ~$99/yr), deferred to 1.0 — see
[ADR-0002](adr/0002-first-release-v0.1.0.md).

### Provider data is hints, never results

External metadata (VocaDB BPM, LRCLIB lyrics) enters the library as
`import`/hint provenance and is verified by the local detector before
it can own a column. A malicious provider response cannot silently
overwrite a human-curated field — the trust stack (L2) bounces it.
See [AGENTS.md](../AGENTS.md) and [PRODUCT.md](PRODUCT.md) § Pillar 1.

## 1.0 hardening

- A strict CSP (script-src self, no inline) once the frontend is
  audited for inline handlers.
- Signed + notarized macOS build (Developer ID).
- CI gate including `scripts/acceptance.sh` (landed in `0.1.0` —
  `.github/workflows/ci.yml`).

## Reporting

Pre-alpha: file an issue. No embargoed-disclosure channel is staffed
yet; that arrives with the 1.0 security review.
