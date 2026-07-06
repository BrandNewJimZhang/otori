# ADR-0001: Name, shell, and architecture split

Date: 2026-07-06
Status: accepted

## Context

We are building a desktop music player whose three pillars are
Swinsian-grade tag management, spectrum visualization, and synced
scrolling lyrics. It must be agent-friendly: an AI agent should be able
to drive the full feature surface without the GUI.

## Decisions

### 1. Name: Ōtori (display) / `otori` (machine)

- Display name `Ōtori` (GUI title, About, README); machine name `otori`
  (CLI command, crate names, bundle id `com.jimzhang.otori`).
- Inspired by 鳳えむ (Otori Emu) of Wonderlands×Showtime; 鳳 = phoenix,
  echoing Phoenix Wonderland. Bonus reading: 音鳥 (bird of sound).
- "Wonderhoy" was considered and rejected as the product name: it is a
  character-specific coined catchphrase pointing 100% at the IP owner
  (SEGA/Colorful Palette, an aggressive trademark enforcer). No
  registration found (JPO/USPTO searched 2026-07-06), but unfair
  competition law covers well-known unregistered marks, and the mark
  could be registered later, forcing a rename. Wonderhoy survives as an
  in-app theme name (`otori theme wonderhoy`) and CLI output flair —
  legally fair-use-grade, spiritually intact.
- Collision check (2026-07-06): crates.io, npm, Homebrew all free;
  GitHub has only inactive 0-3 star hits; the dormant OTORI SSRF tool
  is a different domain entirely.

### 2. Shell: Tauri 2, macOS-first but portable

- Tauri over Electron: ~10MB footprint, and the three heavy jobs (scan,
  tag write, decode) are all sweet spots of the Rust ecosystem (`lofty`,
  `symphonia`) where the JS ecosystem is weakest (tag *writing* in
  particular).
- macOS is the only supported target for now; we keep portability by
  not calling mac-only APIs from the core.

### 3. Architecture: one core, two thin consumers

```
otori-core (Rust) ← otori-cli (agents/scripts)
                  ← src-tauri + src/ (humans)
```

- `otori-core` owns library scanning/indexing (SQLite), tag read/write,
  lyrics parsing. It is the single source of truth; no consumer touches
  files or the index directly.
- The GUI frontend is 100% TypeScript (Vite + React). The user writes
  and reviews TS; Rust stays a thin, agent-written engine room.
- CLI contract: `--json` everywhere with stable schemas, dry-run by
  default for destructive ops, semantic exit codes, structured errors
  on stderr. MCP, if ever needed, wraps the CLI.

### 4. Frontend stack: Vite + React (Next.js considered and rejected)

- Next.js inside Tauri must run as `output: 'export'` (static export):
  no server exists in the shipped app, so SSR, Server Components, API
  routes, and server-dependent image/font optimization are all dead
  weight. What survives (file routing, Fast Refresh) Vite covers with
  a lighter toolchain that matches Tauri's mainstream documented path.
- A single-window player with global long-lived objects (playback
  state, AudioContext, spectrum canvas) barely uses page routing,
  further shrinking Next's residual value.
- Decision challenged and reconfirmed 2026-07-06: author familiarity
  with Next.js was weighed as a real architectural property, but the
  parts actually written day-to-day (React components, hooks, TSX) are
  identical in both stacks — only the invisible build layer differs.

### 5. Playback: `<audio>` element first, engine behind an interface

- MVP plays via the WebView `<audio>` element + Web Audio
  `AnalyserNode` for the live spectrum. Cheap, one day of work.
- Format ceiling (e.g. FLAC in WKWebView) and gapless playback may
  force a native engine (`symphonia` + `cpal`) later; the frontend
  playback module is therefore written against an interface so the
  engine can be swapped without touching UI code.

## Consequences

- Tag write safety (backup before write, dry-run diffs) is a core-level
  invariant, not a GUI feature.
- Anything the GUI can do must be expressible as a CLI call; feature
  work that violates this parity needs an ADR.
