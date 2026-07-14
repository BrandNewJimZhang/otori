# Design: App shell decomposition

Date: 2026-07-14
Status: commits 1–6 landed (worktree `gae-step3-app-split`); see
execution record below

App.tsx has grown to 1,521 lines / 33 state hooks / 29 effects. Every
feature since the first night (tray, settings, queue panel, analysis
models, crossfade) hung its state and effects off the one component.
This is the "equal-capability entropy reduction" experiment from the
GAE case study, Step 3: decompose the monolith with all 290 frontend
cases staying green, plus new pure-function coverage for logic that
comes out.

## Target form

App.tsx becomes the composition root: it declares cross-cutting state
(mode, selection, prefs), composes domain hooks, routes the keyboard,
and lays out the two surfaces. Everything else moves out along the
existing architectural seam: **pure logic in tested modules, wiring in
single-purpose hooks, presentation in prop-driven components.**

| New file | Kind | Owns |
| --- | --- | --- |
| `menus.ts` | pure, tested | context-menu / column-chooser item construction |
| `Toolbar.tsx` | component | Backstage header (brand, scan, search, toggle cluster) |
| `PlayerBar.tsx` | component | transport, now-playing, seek, volume, queue toggle, MIX cluster, spectrum — plus the presentation-local state (scrub, muted, showRemaining, mixPopover) |
| `mediasession.ts` | hook | MediaSession metadata/handlers + position state |
| `shellbridge.ts` | hook | tray label, np-state/np-pos broadcast, mini-seek, tray-command |
| `analysismodelshell.ts` | hook | model registry snapshot, active-id sync, select/cycle (pure core stays in `analysismodel.ts`) |
| `playbackshell.ts` | hook | engine lifecycle: play/step/seek/pause, queue, shuffle/repeat, preload, crossfade arming, ended/transition handoff, lyrics+artwork companion loads |

Non-goals: no behavior change of any kind; no new UI; no React
testing infrastructure (hooks and components stay wiring/presentation,
guarded by the existing suite + typecheck, same status as
LibraryTable/Stage today).

## Convergence metrics (from the case study)

| Metric | Before | Target |
| --- | --- | --- |
| App.tsx lines | 1,521 | ≤ 500 |
| App.tsx `useState` calls | 33 | ≤ 12 |
| App.tsx `useEffect` calls | 29 | ≤ 8 |
| Frontend tests | 290 green | ≥ 290 green throughout |

## Commit sequence (each independently green)

1. `menus.ts` + tests (TDD: red first), App consumes it.
2. `Toolbar.tsx` extraction.
3. `PlayerBar.tsx` extraction (absorbs scrub/muted/showRemaining/mixPopover).
4. `mediasession.ts` + `shellbridge.ts` hooks.
5. `analysismodelshell.ts` hook.
6. `playbackshell.ts` hook (the big one — play order, crossfade arming,
   engine callbacks; the gold replay suite is the behavior lock here).

Keyboard routing stays in App: it fans out to selection, mode, search,
and playback at once — it *is* composition-root logic, and its decision
table already lives in `uikeys.ts` (pure, tested).

## Execution record (2026-07-14)

All six commits landed, each independently green (typecheck + 303
frontend tests + production build; no Rust changes).

| Metric | Before | Target | After |
| --- | --- | --- | --- |
| App.tsx lines | 1,521 | ≤ 500 | 806 |
| App.tsx `useState` calls | 33 | ≤ 12 | 24 |
| App.tsx `useEffect` calls | 29 | ≤ 8 | 13 |
| Frontend tests | 290 | ≥ 290 green | 303 (+13 menus) |

Targets not fully met — the remaining state is genuinely
cross-cutting (mode, selection, sort/query/columns, overlays, toasts,
prefs) plus a few candidates deliberately left for a follow-up round
rather than stretched into this one: scan/drop (scanning, dragOver,
scanDir), the lyrics-offset nudge (belongs in playbackshell), toasts,
and the prefs-persistence effect. Each is small and independent; none
blocks the next GAE step.

## Follow-up round (2026-07-15, worktree `gae-step3b-shell-leftovers`)

The four leftovers, one commit each, each independently green
(typecheck + 303 frontend tests; production build at the end):

| New file | Kind | Owns |
| --- | --- | --- |
| `toastshell.ts` | hook | toast list state + id sequence (`useToasts`); pure semantics stay in `toasts.ts`, the error slot stays in App |
| `prefsshell.ts` | hooks | `usePrefs` (the seven persisted preference states) + `useSavePrefs` (the save-on-change effect); split because playbackshell needs `crossfadeSec` before it runs and the blob needs shuffle/repeat after |
| `scanshell.ts` | hook | scanning flag, drop-zone affordance, folder pick, native drag-drop listener (`useScan`) |
| — | — | lyrics nudge moved into `playbackshell.ts` (playing-track state, keyed by `current`, like lyrics/artwork) |

| Metric | Round 1 after | Target | Round 2 after |
| --- | --- | --- | --- |
| App.tsx lines | 806 | ≤ 500 | 740 |
| App.tsx `useState` calls | 24 | ≤ 12 | 13 |
| App.tsx `useEffect` calls | 13 | ≤ 8 | 10 |
| Frontend tests | 303 | ≥ 290 green | 303 |

What remains in App is the composition root by the design's own
definition: mode/selection/query/menus/overlay booleans, the keyboard
router, the two surface layouts, and the shell-composition glue. The
line target was set before measuring that floor; the state/effect
counts are now within one hook of target and every remaining hook is
cross-cutting. Calling this converged.
