// App shell: Backstage (dense table, management) / Stage (performance)
// with a one-keystroke toggle (PRODUCT.md Pillar 2). Table presentation
// lives in LibraryTable, view logic in library.ts — App owns state.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { getArtwork, listTracks, scanLibrary, setDisplayAwake, setLyricsOffset, reopenAnalysis } from "./ipc";
import { createEngine } from "./playback";
import { Stage } from "./Stage";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { LibraryTable, type ColumnWidths } from "./LibraryTable";
import { createArtworkCache } from "./artworkcache";
import { ToastStack } from "./ToastStack";
import { useToasts } from "./toastshell";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { SettingsOverlay } from "./SettingsOverlay";
import {
  clickSelect,
  contextTargets,
  displayTitle,
  edgeSelect,
  emptySelection,
  filterTracks,
  selectAll,
  sortTracks,
  stepSelect,
  toggleColumn,
  toggleSort,
  typeAheadSelect,
  type Selection,
  type SortKey,
  type SortSpec,
} from "./library";
import { columnMenuItems, trackMenuItems } from "./menus";
import { cycleRepeat, upcomingPreview } from "./playorder";
import { enqueueNext, queueMove, queueRemove } from "./queue";
import { QueuePanel } from "./QueuePanel";
import { InspectorPanel } from "./InspectorPanel";
import { escapeIntent, routeKey, zoneOf, type KeyZone } from "./uikeys";
import { StageIcon } from "./icons";
import { PlayerBar } from "./PlayerBar";
import { Toolbar } from "./Toolbar";
import { useMediaSession } from "./mediasession";
import { useShellBridge } from "./shellbridge";
import { usePlaybackShell } from "./playbackshell";
import { StatusBar } from "./StatusBar";
import { statusLine } from "./statusline";
import { onSweepProgress, startAnalysisSweep, type SweepProgress } from "./analysissweep";
import { useAnalysisModelShell } from "./analysismodelshell";
import { loadPrefs, savePrefs, type Density, type Theme } from "./prefs";
import type { TrackRow } from "./types";
import "./App.css";

// Volume/sort survive restarts (window size: tauri-plugin-window-state
// if it ever matters). Read once at module load, saved on change.
const initialPrefs = loadPrefs(localStorage);

type Mode = "backstage" | "stage";

interface MenuState {
  x: number;
  y: number;
  /** Rows the menu acts on (clicked row, or the multi-selection containing it). */
  targets: TrackRow[];
}

function App() {
  const [mode, setMode] = useState<Mode>("backstage");
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  // Per-track sync nudge, mirrored from the index row; [ / ] update it.
  const [lyricsOffsetMs, setLyricsOffsetMs] = useState(0);
  // Shared lazy cover cache for the table (dedup + IPC concurrency cap +
  // negative caching). Created once; the table drives it from view.
  const artworkCache = useRef(
    createArtworkCache((path) => getArtwork(path).then((a) => a?.dataUrl ?? null)),
  ).current;
  const [scanning, setScanning] = useState(false);
  // Toast stack (audit r5 P1): scan reports and transient info; the
  // error keeps its own slot (persistent until dismissed).
  const toast = useToasts();
  const [error, setError] = useState<string | null>(null);
  // Drag-over scan affordance (audit r5 P1): full-window drop zone.
  const [dragOver, setDragOver] = useState(false);
  const [volume, setVolume] = useState(initialPrefs.volume);
  const [theme, setTheme] = useState<Theme>(initialPrefs.theme);
  const [fullscreen, setFullscreen] = useState(false);
  const [crossfadeSec, setCrossfadeSec] = useState(initialPrefs.crossfadeSec);
  const [density, setDensity] = useState<Density>(initialPrefs.density);
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(initialPrefs.columnWidths);
  // Columns hidden via the header context menu; persisted like widths.
  const [hiddenColumns, setHiddenColumns] = useState<readonly SortKey[]>(
    initialPrefs.hiddenColumns,
  );
  // Header right-click: the show/hide column chooser (rows keep `menu`).
  const [columnMenu, setColumnMenu] = useState<{ x: number; y: number } | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortSpec | null>(initialPrefs.sort);
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Shortcuts overlay (audit r5 P2): "?" reveals the keyboard model.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Settings overlay (⌘,): one home for the scattered pref switches.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Up-next panel (audit r5 P0): queue + order preview, toggled from
  // the player bar.
  const [queueOpen, setQueueOpen] = useState(false);
  // Tag inspector (design: docs/design/tag-inspector.md): ⌘I / View
  // menu; renders only in Backstage with a non-empty selection.
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const engine = useMemo(createEngine, []);
  const searchRef = useRef<HTMLInputElement>(null);

  // Playback order follows what the user sees: filtered, then sorted.
  const visible = useMemo(
    () => sortTracks(filterTracks(tracks, query), sort),
    [tracks, query, sort],
  );
  // Playback shell (playbackshell.ts): now-playing state, play order
  // stepping, queue, shuffle/repeat, preload, crossfade arming, and
  // the engine callbacks. The gold replay suite locks its behavior.
  const {
    current,
    paused,
    position,
    lyrics,
    artwork,
    queue,
    setQueue,
    shuffle,
    repeat,
    setRepeat,
    duration,
    frozenShuffleOrder,
    play,
    step,
    toggleShuffle,
    seekTo,
    togglePause,
    getPositionMs,
  } = usePlaybackShell(
    engine,
    visible,
    crossfadeSec,
    { shuffle: initialPrefs.shuffle, repeat: initialPrefs.repeat },
    setError,
  );

  // Queue badge lookup: track id → 1-based position.
  const queuePositions = useMemo(
    () => new Map(queue.map((id, i) => [id, i + 1])),
    [queue],
  );
  // Up-next panel data: queued rows in order, then where the play
  // order continues after the queue drains (short preview).
  const queueTracks = useMemo(() => {
    const byId = new Map(visible.map((t) => [t.id, t]));
    return queue.map((id) => byId.get(id)).filter((t): t is TrackRow => t != null);
  }, [queue, visible]);
  // Inspector subjects: selected rows in table order. Recomputed from
  // `tracks` so a save (via library-changed refresh) updates the panel.
  const inspected = useMemo(() => {
    if (!inspectorOpen) return [];
    return visible.filter((t) => selection.ids.has(t.id));
  }, [inspectorOpen, visible, selection]);
  const upcoming = useMemo(() => {
    if (!queueOpen) return []; // panel closed: skip the walk
    const byId = new Map(visible.map((t) => [t.id, t]));
    return upcomingPreview(
      visible.map((t) => t.id),
      queue,
      current?.id ?? null,
      frozenShuffleOrder(),
      repeat,
      5,
    )
      .map((id) => byId.get(id))
      .filter((t): t is TrackRow => t != null);
  }, [queueOpen, visible, current, shuffle, repeat, queue, frozenShuffleOrder]);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const currentRef = useRef(current);
  currentRef.current = current;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Type-ahead buffer: keystrokes within 800ms accumulate (Finder-style).
  const typeAheadRef = useRef<{ buffer: string; timer: number }>({ buffer: "", timer: 0 });

  const refresh = useCallback(() => {
    listTracks().then(setTracks).catch((e) => setError(String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  // Background analysis sweep: fill the index's pending list (BPM +
  // mix anchors) this session. Kicks on mount and again on library
  // changes (new scans add rows).
  useEffect(startAnalysisSweep, []);
  // Sweep progress for the status bar (null = idle): current track id
  // (resolved to a title below), tracks left, and a rolling ETA.
  const [sweep, setSweep] = useState<SweepProgress | null>(null);
  useEffect(() => onSweepProgress(setSweep), []);
  // Title/artist of the track the sweep is chewing right now (filename
  // fallback via displayTitle), or null when idle/unknown. App owns the
  // id→row map; the sweep only ever reports ids.
  const sweepNowPlaying = useMemo(() => {
    if (!sweep?.currentId) return null;
    const t = tracks.find((row) => row.id === sweep.currentId);
    return t ? { title: displayTitle(t), artist: t.artist } : null;
  }, [sweep?.currentId, tracks]);

  // Analysis-model shell state (registry, active id, select/cycle):
  // wiring in analysismodelshell.ts, decision paths in analysismodel.ts.
  const analysis = useAnalysisModelShell(initialPrefs.analysisModel, setError, toast.push);

  // L5 coexistence, UI half (AGENTS.md "Coexistence with the GUI"): the
  // shell emits `library-changed` when an external writer (CLI/agent)
  // commits; re-fetch so the table reflects it within ~1s.
  useEffect(() => {
    const unlisten = listen("library-changed", () => {
      refresh();
      startAnalysisSweep();
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, [refresh]);  // Apply the persisted volume to the engine once it exists.
  useEffect(() => {
    engine.volume = initialPrefs.volume;
  }, [engine]);

  useEffect(() => {
    savePrefs(localStorage, {
      volume,
      sort,
      shuffle,
      repeat,
      theme,
      crossfadeSec,
      density,
      columnWidths,
      hiddenColumns,
      analysisModel: analysis.model,
    });
  }, [volume, sort, shuffle, repeat, theme, crossfadeSec, density, columnWidths, hiddenColumns, analysis.model]);

  // Theme rides a root attribute so CSS owns the palettes; Stage stays
  // dark regardless (a lit stage is not a stage). "auto" follows the
  // system appearance live (audit r5 P2).
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "auto" ? (mq.matches ? "light" : "dark") : theme;
    };
    apply();
    if (theme !== "auto") return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  // Fullscreen hides the traffic lights, so the toolbar's left padding
  // for them must go too (the audit's "empty corner" in fullscreen).
  useEffect(() => {
    const win = getCurrentWindow();
    const sync = () => {
      win.isFullscreen().then(setFullscreen).catch(() => {});
    };
    sync();
    const unlisten = win.onResized(sync);
    return () => {
      unlisten.then((off) => off());
    };
  }, []);

  // The playing track's sync nudge follows the current row (external
  // writers may change it too — rows refresh on library-changed).
  useEffect(() => {
    setLyricsOffsetMs(current?.lyrics_offset_ms ?? 0);
  }, [current]);
  const lyricsOffsetRef = useRef(lyricsOffsetMs);
  lyricsOffsetRef.current = lyricsOffsetMs;

  /** Nudge lyric sync ±ms for the playing track; persists to the index. */
  const nudgeLyrics = useCallback((deltaMs: number) => {
    const cur = currentRef.current;
    if (!cur) return;
    const next = lyricsOffsetRef.current + deltaMs;
    setLyricsOffsetMs(next);
    setLyricsOffset(cur.id, next).catch((e) => setError(String(e)));
    // Keep the library rows coherent without a refetch round-trip.
    setTracks((ts) =>
      ts.map((t) => (t.id === cur.id ? { ...t, lyrics_offset_ms: next } : t)),
    );
  }, []);

  // Stage is a performance surface: keep the display awake while it
  // plays; release on pause, on leaving Stage, and on unmount.
  useEffect(() => {
    const awake = mode === "stage" && !paused;
    setDisplayAwake(awake).catch(() => {}); // cosmetic failure, never fatal
    return () => {
      if (awake) setDisplayAwake(false).catch(() => {});
    };
  }, [mode, paused]);

  // System Now Playing / media keys (mediasession.ts) and the shell
  // bridges: tray labels, mini-panel np-state/np-pos broadcast, and
  // inbound mini-seek / tray-command events (shellbridge.ts).
  useMediaSession(engine, current, artwork, position, togglePause, step, seekTo);
  const onMiniSeek = useCallback(
    (secs: number) => {
      if (currentRef.current) seekTo(secs);
    },
    [seekTo],
  );
  const onTrayCommand = useCallback(
    (cmd: string) => {
      if (cmd === "playpause") {
        if (currentRef.current) togglePause();
      } else if (cmd === "next") step(1);
      else if (cmd === "prev") step(-1);
    },
    [togglePause, step],
  );
  useShellBridge(engine, current, paused, artwork, position, {
    onMiniSeek,
    onTrayCommand,
  });

  // Native menu-bar items (src-tauri setup_app_menu) arrive as
  // `menu-command` events — the third front-end for the same handlers.
  useEffect(() => {
    const unlisten = listen<string>("menu-command", (e) => {
      switch (e.payload) {
        case "playpause":
          if (currentRef.current) togglePause();
          break;
        case "next":
          step(1);
          break;
        case "prev":
          step(-1);
          break;
        case "stage":
          setMode((m) => (m === "backstage" ? "stage" : "backstage"));
          break;
        case "inspector":
          setInspectorOpen((o) => !o);
          break;
        case "scan":
          void pickAndScan();
          break;
        case "reanalyze":
          // Whole-library reopen; the sweep chews through it at idle
          // priority and the status bar shows the queue.
          void reopenAnalysis()
            .then(() => startAnalysisSweep())
            .catch((err) => setError(String(err)));
          break;
      }
    });
    return () => {
      unlisten.then((off) => off());
    };
    // pickAndScan is stable in practice (closes over setters only).
  }, [togglePause, step]);

  // Keyboard, routed through the uikeys decision table (audit P0): a
  // focused button keeps native Enter/Space activation, sliders keep
  // their arrows, inputs own everything but Escape; ⌘←/→ steps tracks,
  // ←/→ nudges the seek position, CapsLock-S still toggles mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      const zone: KeyZone = zoneOf(t instanceof HTMLElement ? t : null);
      // Lyric sync nudge (Stage): [ = lyrics earlier, ] = later. Handled
      // before the routing table: Stage renders no table, so this cannot
      // collide with type-ahead; Backstage keeps [ ] as printable input.
      if (mode === "stage" && zone === "global" && (e.key === "[" || e.key === "]")) {
        e.preventDefault();
        nudgeLyrics(e.key === "[" ? -100 : 100);
        return;
      }
      const action = routeKey(
        { key: e.key, meta: e.metaKey || e.ctrlKey, shift: e.shiftKey },
        zone,
        modeRef.current,
      );
      if (action.kind === "native") return;
      e.preventDefault();
      switch (action.kind) {
        case "focus-search":
          searchRef.current?.focus();
          break;
        case "blur-input":
          (t as HTMLInputElement).blur();
          break;
        case "toggle-mode":
          setMode((m) => (m === "backstage" ? "stage" : "backstage"));
          break;
        case "toggle-pause":
          if (currentRef.current) togglePause();
          break;
        case "select-step":
          setSelection((sel) =>
            stepSelect(sel, visibleRef.current, action.offset, action.extend),
          );
          break;
        case "select-all":
          setSelection((sel) => selectAll(sel, visibleRef.current));
          break;
        case "select-edge":
          setSelection(edgeSelect(visibleRef.current, action.edge));
          break;
        case "select-page": {
          // One "page" ≈ 20 rows; a viewport-derived count needs the
          // row height, which lives in CSS — good enough for triage.
          const PAGE = 20;
          setSelection((sel) => {
            let s = sel;
            for (let i = 0; i < PAGE; i++) s = stepSelect(s, visibleRef.current, action.offset);
            return s;
          });
          break;
        }
        case "type-ahead": {
          const ta = typeAheadRef.current;
          window.clearTimeout(ta.timer);
          ta.buffer += action.char;
          ta.timer = window.setTimeout(() => {
            ta.buffer = "";
          }, 800);
          setSelection((sel) => typeAheadSelect(sel, visibleRef.current, ta.buffer));
          break;
        }
        case "play-selected": {
          const sel = selectionRef.current;
          const track = visibleRef.current.find((tr) => sel.ids.has(tr.id));
          if (track) void play(track);
          break;
        }
        case "seek-nudge":
          if (currentRef.current && Number.isFinite(engine.duration)) {
            const pos = Math.max(0, Math.min(engine.duration, engine.currentTime + action.secs));
            seekTo(pos);
          }
          break;
        case "step-track":
          if (currentRef.current) step(action.offset);
          break;
        case "show-shortcuts":
          setShortcutsOpen(true);
          break;
        case "show-settings":
          setSettingsOpen((o) => !o);
          break;
        case "toggle-inspector":
          setInspectorOpen((o) => !o);
          break;
        case "escape":
          switch (escapeIntent(modeRef.current, selectionRef.current.ids.size > 0)) {
            case "exit-stage":
              setMode("backstage");
              break;
            case "clear-selection":
              setSelection(emptySelection);
              break;
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePause, play, step, engine, mode, nudgeLyrics]);

  async function pickAndScan() {
    const dir = await openDialog({ directory: true });
    if (typeof dir !== "string") return;
    await scanDir(dir);
  }

  async function scanDir(dir: string) {
    setScanning(true);
    setError(null);
    try {
      const report = await scanLibrary(dir);
      const parts = [`Added ${report.added}, updated ${report.updated}`];
      if (report.skipped_icloud.length > 0) parts.push(`${report.skipped_icloud.length} in iCloud`);
      if (report.unreadable.length > 0) parts.push(`${report.unreadable.length} unreadable`);
      toast.push(parts.join(" · "));
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

  // Drag a folder anywhere onto the window to scan it (audit P1).
  // Tauri delivers native file drops as events (webview drag data has
  // no paths); scanning is idempotent, so over-triggering is safe.
  // enter/over light the drop-zone overlay (audit r5 P1: the feature
  // was invisible without an affordance).
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onDragDropEvent((e) => {
      if (e.payload.type === "drop") {
        setDragOver(false);
        if (e.payload.paths.length > 0) void scanDir(e.payload.paths[0]);
      } else if (e.payload.type === "leave") {
        setDragOver(false);
      } else {
        setDragOver(true); // enter + over
      }
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, []);

  // Row context menu + header column chooser: menus.ts decides the
  // items (pure, tested); App supplies the doers and owns the state.
  const menuItems: MenuItem[] = useMemo(() => {
    if (!menu) return [];
    return trackMenuItems(menu.targets, queue, {
      play: (t) => void play(t),
      getInfo: (targets) => {
        // Single row: focus the selection on it (design r2). Multi:
        // the targets already are the selection.
        if (targets.length === 1) {
          setSelection({ ids: new Set([targets[0].id]), anchor: targets[0].id });
        }
        setInspectorOpen(true);
      },
      queueAdd: (ids) => setQueue((q) => enqueueNext(q, ids)),
      queueRemove: (ids) => setQueue((q) => q.filter((id) => !ids.includes(id))),
      revealInFinder: (path) => void revealItemInDir(path).catch((e) => setError(String(e))),
      copyText: (text) => void navigator.clipboard.writeText(text).catch(() => {}),
      reanalyze: (ids) =>
        void reopenAnalysis({ trackIds: ids })
          .then(() => startAnalysisSweep())
          .catch((e) => setError(String(e))),
    });
  }, [menu, play, queue]);

  const columnMenuEntries: MenuItem[] = useMemo(() => {
    if (!columnMenu) return [];
    return columnMenuItems(hiddenColumns, sort, {
      toggle: (key) => setHiddenColumns((h) => toggleColumn(h, key)),
      clearSort: () => setSort(null),
    });
  }, [columnMenu, hiddenColumns, sort]);

  if (mode === "stage" && current) {
    return (
      // key remounts the surface per mode switch so .app's enter
      // animation runs both ways (audit r5 P0: no hard cut).
      <div key="stage" className="app stage-mode" onDoubleClick={() => setMode("backstage")}>
        <Stage
          track={current}
          artwork={artwork}
          lyrics={lyrics}
          analyser={engine.analyser}
          getPositionMs={getPositionMs}
          positionSec={position}
          outputLatencyMs={engine.outputLatencyMs}
          lyricsOffsetMs={lyricsOffsetMs}
          duration={duration}
          paused={paused}
          shuffle={shuffle}
          repeat={repeat}
          onSeek={seekTo}
          onTogglePause={togglePause}
          onStep={step}
          onToggleShuffle={toggleShuffle}
          onCycleRepeat={() => setRepeat(cycleRepeat)}
        />
        <ToastStack
          toasts={toast.toasts}
          error={error}
          onDismiss={toast.dismiss}
          onDismissError={() => setError(null)}
        />
      </div>
    );
  }

  function changeVolume(v: number) {
    engine.volume = v;
    setVolume(v);
  }

  function onSort(key: SortKey) {
    setSort((s) => toggleSort(s, key));
  }

  return (
    <div key="backstage" className="app">
      <Toolbar
        fullscreen={fullscreen}
        scanning={scanning}
        query={query}
        visibleCount={visible.length}
        trackCount={tracks.length}
        searchRef={searchRef}
        canStage={current != null}
        inspectorOpen={inspectorOpen}
        density={density}
        theme={theme}
        analysisModel={analysis.model}
        analysisModels={analysis.models}
        analysisSwitching={analysis.switching}
        settingsOpen={settingsOpen}
        onScan={() => void pickAndScan()}
        onQuery={setQuery}
        onEnterStage={() => setMode("stage")}
        onToggleInspector={() => setInspectorOpen((o) => !o)}
        onToggleDensity={() => setDensity((d) => (d === "comfortable" ? "compact" : "comfortable"))}
        onCycleTheme={() => setTheme((t) => (t === "dark" ? "light" : t === "light" ? "auto" : "dark"))}
        onCycleAnalysisModel={analysis.cycle}
        onToggleSettings={() => setSettingsOpen((o) => !o)}
      />

      <main className={`library density-${density} ${inspectorOpen ? "with-inspector" : ""}`}>
        {tracks.length === 0 ? (
          <div className="empty">
            <StageIcon />
            <p>Your library is empty.</p>
            <button onClick={pickAndScan} disabled={scanning}>
              {scanning ? "Scanning…" : "Scan a folder"}
            </button>
            <p className="empty-hint">…or drop a folder anywhere in this window.</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty">
            <p>No tracks match “{query}”.</p>
          </div>
        ) : (
          <LibraryTable
            tracks={visible}
            playingId={current?.id ?? null}
            paused={paused}
            queuePositions={queuePositions}
            selection={selection}
            sort={sort}
            columnWidths={columnWidths}
            hiddenColumns={hiddenColumns}
            artwork={artworkCache}
            onColumnWidths={setColumnWidths}
            onSort={onSort}
            onRowClick={(id, mods) => setSelection((s) => clickSelect(s, visible, id, mods))}
            onRowContextMenu={(track, e) => {
              e.preventDefault();
              setMenu({
                x: e.clientX,
                y: e.clientY,
                targets: contextTargets(selection, visible, track.id),
              });
            }}
            onHeaderContextMenu={(e) => {
              e.preventDefault();
              setColumnMenu({ x: e.clientX, y: e.clientY });
            }}
            onPlay={play}
          />
        )}
        {inspectorOpen && (
          <InspectorPanel
            tracks={inspected}
            onClose={() => setInspectorOpen(false)}
            onSaved={(txId) => {
              // The save already emitted library-changed; toast the
              // undo handle so a batch mistake is one command away.
              toast.push(`Saved — otori undo ${txId}`);
            }}
            onNotice={toast.push}
            onError={(message) => setError(message)}
          />
        )}
      </main>

      <PlayerBar
        current={current}
        artwork={artwork}
        paused={paused}
        position={position}
        duration={duration}
        shuffle={shuffle}
        repeat={repeat}
        volume={volume}
        queueCount={queue.length}
        queueOpen={queueOpen}
        crossfadeSec={crossfadeSec}
        analyser={engine.analyser}
        onToggleShuffle={toggleShuffle}
        onStep={step}
        onTogglePause={togglePause}
        onCycleRepeat={() => setRepeat(cycleRepeat)}
        onEnterStage={() => setMode("stage")}
        onLocate={(t) => setSelection({ ids: new Set([t.id]), anchor: t.id })}
        onSeek={seekTo}
        onVolume={changeVolume}
        onMuteVolume={(v) => {
          engine.volume = v;
        }}
        onToggleQueue={() => setQueueOpen((v) => !v)}
        onCrossfadeSec={setCrossfadeSec}
      />

      <StatusBar
        line={statusLine({
          tracks: tracks.length,
          analyzed: tracks.filter((t) => t.bpm != null || t.mix_analyzed).length,
          scanning,
          sweep: sweep
            ? { remaining: sweep.remaining, etaMs: sweep.etaMs }
            : null,
          currentTitle: sweepNowPlaying?.title ?? null,
          currentArtist: sweepNowPlaying?.artist ?? null,
          // Only name the model when it isn't the default — keeps the
          // line quiet for the common case and calls out a switch's
          // re-sweep.
          modelLabel: analysis.model === "small" ? undefined : "Standard",
        })}
        scanning={scanning}
      />

      {queueOpen && (
        <QueuePanel
          queueTracks={queueTracks}
          upcoming={upcoming}
          onPlay={(t) => {
            setQueue((q) => q.filter((id) => id !== t.id));
            void play(t);
          }}
          onMove={(id, offset) => setQueue((q) => queueMove(q, id, offset))}
          onRemove={(id) => setQueue((q) => queueRemove(q, new Set([id])))}
          onClear={() => setQueue([])}
          onClose={() => setQueueOpen(false)}
        />
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      {columnMenu && (
        <ContextMenu
          x={columnMenu.x}
          y={columnMenu.y}
          items={columnMenuEntries}
          onClose={() => setColumnMenu(null)}
        />
      )}

      <ToastStack
        toasts={toast.toasts}
        error={error}
        onDismiss={toast.dismiss}
        onDismissError={() => setError(null)}
      />

      {dragOver && (
        <div className="drop-zone" aria-hidden="true">
          <div className="drop-zone-label">Drop a folder to scan it</div>
        </div>
      )}

      {shortcutsOpen && <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}

      {settingsOpen && (
        <SettingsOverlay
          theme={theme}
          onTheme={setTheme}
          density={density}
          onDensity={setDensity}
          crossfadeSec={crossfadeSec}
          onCrossfadeSec={setCrossfadeSec}
          analysisModel={analysis.model}
          analysisModels={analysis.models}
          analysisSwitching={analysis.switching}
          onSelectAnalysisModel={analysis.select}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

export default App;
