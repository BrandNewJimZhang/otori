# ADR-0001: Name, shell, and architecture split

Date: 2026-07-06
Status: accepted (amended 2026-07-07 — see Amendments)

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
  on stderr.
- MCP server: considered and dropped (2026-07-07). The CLI is the one
  and only agent surface; a second protocol surface would double the
  contract-maintenance cost before a single agent asks for it. Revisit
  only if a real agent integration is blocked by the lack of a
  long-lived connection (e.g. realtime playback control).

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

## Amendments (2026-07-07)

Reality check against the shipped code, one day in. Section numbers
refer to Decisions above.

### A1. Audio analysis runs in the GUI, not the core (amends §3)

- Web Audio is the only decoder in the stack — the core never gained
  symphonia. BPM/beat-grid detection therefore lives in the frontend
  (`beatgrid.ts`, `beatservice.ts`, `analysissweep.ts`); the core owns
  only the bookkeeping (`analysis.rs`: pending list, verdicts, mix
  anchors).
- Deliberate inversion of "core owns everything": adding a Rust
  decoder solely for analysis would duplicate one the WebView already
  ships. If a native playback engine ever lands (§5), analysis should
  move into the core with it.

### A2. Playback grew into a two-deck DJ-mix engine (extends §5)

- The `<audio>`-element MVP became a two-deck architecture: the next
  track preloads on the idle deck for near-gapless handoff, and
  tempo-compatible pairs get beat-matched transitions (`djmix.ts`
  plans, the engine executes). The §5 interface bet paid off — UI code
  never touched engine internals through the evolution.
- Native engine (symphonia + cpal) remains a possibility, not a plan.

### A3. New capability: online metadata/lyrics providers (extends §3)

- `otori-core` gained a provider layer (`provider.rs`): VocaDB for
  editor-curated BPM/metadata, LRCLIB for synced lyrics. Network I/O
  in the core was not in the original decision; it lives there so CLI
  and GUI share one implementation (same reasoning as tag writes).
- External values are hints, never results: the local detector
  verifies every hint and owns the bpm column (`bpm_source` records
  `detected` vs `detected+hint`).
- Unofficial/grey-area providers (e.g. NetEase lyrics) stay out of the
  repo: scripts live in `local/`, excluded via `.git/info/exclude`.

### A4. Wonderhoy theme: demoted from commitment to backlog (amends §1)

- `otori theme wonderhoy` was never built. Shipped theming is
  dark/light/auto via a CSS root attribute — no named-theme subsystem
  exists, and none is planned. The name stays reserved as future
  output flair; §1's "survives as an in-app theme" should be read as
  intent, not a commitment.

### A5. GUI tag editing joins the parity rule (extends Consequences)

- A Backstage tag inspector (Swinsian-style side panel) is approved
  (2026-07-07). Its writes must route through `otori-core` via Tauri
  IPC — never frontend file access — so provenance, journal, backups,
  and the single-writer lock apply identically to GUI, CLI, and
  agents. GUI edits earn `human` provenance (born curated); this is
  the only low-friction path for humans to enter the trust model,
  since external editors re-enter as `import`.

### A6. Analysis moves into the core after all (supersedes A1)

- Decided 2026-07-07 (same day A1 was written — the reality moved
  fast). The classical frontend detector's accuracy ceiling (octave
  errors, weak-percussion failures) justifies what A1 deferred:
  a Rust-side decode path. A new `otori-analysis` crate wraps the
  `beat-this` crate (Beat This! transformer, pure-Rust rten ONNX
  runtime; symphonia decode).
- A1's reasoning ("don't duplicate the WebView's decoder") is
  overtaken, not refuted: the duplication now buys SOTA accuracy,
  CLI parity for analysis (`otori analyze`), and downbeat data the
  DJ-mix engine can use. Playback decoding stays in the WebView —
  A1 dies only for analysis.
- Model weights (~10 MB) are downloaded artifacts, never committed;
  design: `docs/design/bpm-analysis-rust.md`.
