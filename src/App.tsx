// App shell: Backstage (dense table, management) / Stage (performance)
// with a one-keystroke toggle (PRODUCT.md Pillar 2). Table presentation
// lives in LibraryTable, view logic in library.ts — App owns state.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { getArtwork, getLyrics, listTracks, scanLibrary, setDisplayAwake, updateTray } from "./ipc";
import { createEngine } from "./playback";
import { Spectrum } from "./Spectrum";
import { Stage } from "./Stage";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { LibraryTable, type ColumnWidths } from "./LibraryTable";
import { formatTime } from "./format";
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
  toggleSort,
  typeAheadSelect,
  type Selection,
  type SortKey,
  type SortSpec,
} from "./library";
import { cycleRepeat, effectiveOrder, nextId, shuffledIds, type RepeatMode } from "./playorder";
import { dequeue, enqueueNext } from "./queue";
import { routeKey, type KeyZone } from "./uikeys";
import { seekMax, seekShown } from "./seekbar";
import {
  DensityIcon,
  MoonIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  RepeatIcon,
  ShuffleIcon,
  StageIcon,
  SunIcon,
  VolumeIcon,
} from "./icons";
import { beatGridFor } from "./beatservice";
import { startBpmSweep } from "./bpmsweep";
import { planTransition } from "./djmix";
import { loadPrefs, savePrefs, type Density, type Theme } from "./prefs";
import type { LyricsDoc, ScanReport, TrackRow } from "./types";
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
  const [current, setCurrent] = useState<TrackRow | null>(null);
  const [lyrics, setLyrics] = useState<LyricsDoc | null>(null);
  const [artwork, setArtwork] = useState<string | null>(null);
  const [positionMs, setPositionMs] = useState(0);
  const [paused, setPaused] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [volume, setVolume] = useState(initialPrefs.volume);
  const [shuffle, setShuffle] = useState(initialPrefs.shuffle);
  const [repeat, setRepeat] = useState<RepeatMode>(initialPrefs.repeat);
  const [theme, setTheme] = useState<Theme>(initialPrefs.theme);
  const [fullscreen, setFullscreen] = useState(false);
  const [crossfadeSec, setCrossfadeSec] = useState(initialPrefs.crossfadeSec);
  const [density, setDensity] = useState<Density>(initialPrefs.density);
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(initialPrefs.columnWidths);
  const [muted, setMuted] = useState(false);
  const [showRemaining, setShowRemaining] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortSpec | null>(initialPrefs.sort);
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Scrub preview (audit P0): thumb position while dragging the seek
  // slider; the decoder seek fires once on release, not per pixel.
  const [scrub, setScrub] = useState<number | null>(null);
  // Play-next queue (audit P1): explicit picks preempt the play order.
  const [queue, setQueue] = useState<number[]>([]);
  const engine = useMemo(createEngine, []);
  const searchRef = useRef<HTMLInputElement>(null);
  // Shuffle order is frozen when shuffle turns on (or a track starts
  // outside it) and reconciled against the visible list per step, so
  // filtering mid-shuffle doesn't reshuffle what's already queued.
  const shuffleOrderRef = useRef<number[]>([]);

  // Playback order follows what the user sees: filtered, then sorted.
  const visible = useMemo(
    () => sortTracks(filterTracks(tracks, query), sort),
    [tracks, query, sort],
  );
  // Queue badge lookup: track id → 1-based position.
  const queuePositions = useMemo(
    () => new Map(queue.map((id, i) => [id, i + 1])),
    [queue],
  );
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const currentRef = useRef(current);
  currentRef.current = current;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const shuffleRef = useRef(shuffle);
  shuffleRef.current = shuffle;
  const repeatRef = useRef(repeat);
  repeatRef.current = repeat;
  const queueRef = useRef(queue);
  queueRef.current = queue;
  // Type-ahead buffer: keystrokes within 800ms accumulate (Finder-style).
  const typeAheadRef = useRef<{ buffer: string; timer: number }>({ buffer: "", timer: 0 });

  const refresh = useCallback(() => {
    listTracks().then(setTracks).catch((e) => setError(String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  // Background BPM sweep: fill the index's pending list this session.
  // Kicks on mount and again on library changes (new scans add rows).
  useEffect(startBpmSweep, []);

  // L5 coexistence, UI half (AGENTS.md "Coexistence with the GUI"): the
  // shell emits `library-changed` when an external writer (CLI/agent)
  // commits; re-fetch so the table reflects it within ~1s.
  useEffect(() => {
    const unlisten = listen("library-changed", () => {
      refresh();
      startBpmSweep();
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, [refresh]);

  // Apply the persisted volume to the engine once it exists.
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
    });
  }, [volume, sort, shuffle, repeat, theme, crossfadeSec, density, columnWidths]);

  // Theme rides a root attribute so CSS owns the palettes; Stage stays
  // dark regardless (a lit stage is not a stage).
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
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

  const play = useCallback(
    async (track: TrackRow) => {
      setError(null);
      try {
        await engine.play({ path: track.path, replaygainDb: track.replaygain_db });
        setCurrent(track);
        setPaused(false);
        setPosition(0);
        // Companion surfaces load after playback starts; failures there
        // must never interrupt the music.
        getLyrics(track.path).then(setLyrics).catch(() => setLyrics(null));
        getArtwork(track.path).then(setArtwork).catch(() => setArtwork(null));
      } catch (e) {
        setError(`${displayTitle(track)}: ${e}`);
      }
    },
    [engine],
  );

  // Step through the play order (visible listing, or the frozen
  // shuffle permutation). `manual` distinguishes a user skip from a
  // natural track end — repeat-one only replays on natural ends.
  // A forward step consumes the play-next queue first (audit P1);
  // repeat-one natural replays still win over the queue.
  const step = useCallback(
    (offset: 1 | -1, manual = true) => {
      const list = visibleRef.current;
      const cur = currentRef.current;
      if (offset === 1 && !(repeatRef.current === "one" && !manual)) {
        let popped = queueRef.current;
        // Skip queued ids that left the library since queuing.
        for (;;) {
          const { id, rest } = dequeue(popped);
          if (id == null) break;
          popped = rest;
          const queued = list.find((t) => t.id === id);
          if (queued) {
            setQueue(rest);
            void play(queued);
            return true;
          }
        }
        if (popped !== queueRef.current) setQueue(popped);
      }
      const visibleIds = list.map((t) => t.id);
      const order = shuffleRef.current
        ? effectiveOrder(visibleIds, shuffleOrderRef.current)
        : visibleIds;
      const id = nextId(order, cur?.id ?? null, offset, repeatRef.current, manual);
      const next = id != null ? list.find((t) => t.id === id) : undefined;
      if (next) {
        if (next.id === cur?.id) {
          // Repeat-one replay: restart instead of reloading the file.
          engine.seek(0);
          setPosition(0);
          if (engine.paused) {
            engine.togglePause();
            setPaused(false);
          }
        } else {
          void play(next);
        }
      }
      return Boolean(next);
    },
    [play, engine],
  );

  const toggleShuffle = useCallback(() => {
    setShuffle((on) => {
      const next = !on;
      if (next) {
        // Freeze a permutation of what's visible now, current track first.
        shuffleOrderRef.current = shuffledIds(
          visibleRef.current.map((t) => t.id),
          currentRef.current?.id ?? null,
          Math.random,
        );
      }
      return next;
    });
  }, []);

  // Keep the idle deck preloaded with the track a natural end leads to
  // (gapless). "Next" follows the play-next queue first (audit P1),
  // then the play order — shuffle permutation and repeat included
  // (repeat-one preloads the same file for a gapless replay). Beat
  // grids for the current/next pair warm here too (crossfade planning
  // needs both).
  useEffect(() => {
    const visibleIds = visible.map((t) => t.id);
    const order = shuffle ? effectiveOrder(visibleIds, shuffleOrderRef.current) : visibleIds;
    const queuedId =
      repeat === "one" ? null : (queue.find((qid) => visibleIds.includes(qid)) ?? null);
    const id = queuedId ?? nextId(order, current?.id ?? null, 1, repeat, false);
    const next = id != null ? visible.find((t) => t.id === id) : undefined;
    engine.preloadNext(next ? { path: next.path, replaygainDb: next.replaygain_db } : null);
    if (current) void beatGridFor(current.path);
    if (next) void beatGridFor(next.path);
  }, [engine, visible, current, shuffle, repeat, queue]);

  // DJ crossfade: when enabled and the track nears its end, plan a
  // transition from the two beat grids and hand it to the engine.
  // Beat-matched when tempos are compatible; equal-power otherwise.
  const transitionArmed = useRef<string | null>(null);
  useEffect(() => {
    if (!crossfadeSec || !current) return;
    if (position <= 0 || !Number.isFinite(engine.duration)) return;
    const remaining = engine.duration - position;
    // Lead time: the planned fade plus one beat of slack for planning.
    if (remaining > crossfadeSec + 1 || engine.transitioning) return;
    if (transitionArmed.current === current.path) return;
    transitionArmed.current = current.path;

    // "Next" follows the queue then the play order, same as preload.
    // Repeat-one replays the same file — a crossfade into itself is
    // meaningless, so let the gapless path handle it.
    const visibleIds = visibleRef.current.map((t) => t.id);
    const order = shuffleRef.current
      ? effectiveOrder(visibleIds, shuffleOrderRef.current)
      : visibleIds;
    const queuedId =
      repeatRef.current === "one"
        ? null
        : (queueRef.current.find((qid) => visibleIds.includes(qid)) ?? null);
    const id = queuedId ?? nextId(order, current.id, 1, repeatRef.current, false);
    const next = id != null && id !== current.id ? visibleRef.current.find((t) => t.id === id) : undefined;
    if (!next) return;
    void (async () => {
      const [gridOut, gridIn] = await Promise.all([
        beatGridFor(current.path),
        beatGridFor(next.path),
      ]);
      // Low-confidence grids must not drive a tempo bend: passing null
      // degrades the plan to a plain equal-power crossfade.
      const trusted = (g: typeof gridOut) => (g && g.confidence >= 0.4 ? g : null);
      const plan = planTransition(trusted(gridOut), trusted(gridIn), crossfadeSec);
      // Engine returns false if the preload isn't ready — the track
      // then ends naturally and the gapless path takes over.
      engine.beginTransition(plan);
    })();
  }, [position, crossfadeSec, current, engine]);

  useEffect(() => {
    engine.onTransitionAdvance((path) => {
      const track = visibleRef.current.find((t) => t.path === path);
      if (track) {
        setCurrent(track);
        setPosition(0);
        // The engine may have advanced into the queue head — consume it.
        setQueue((q) => q.filter((id) => id !== track.id));
        getLyrics(track.path).then(setLyrics).catch(() => setLyrics(null));
        getArtwork(track.path).then(setArtwork).catch(() => setArtwork(null));
      }
    });
  }, [engine]);

  // Re-arm the transition trigger whenever the playing track changes.
  useEffect(() => {
    transitionArmed.current = null;
  }, [current]);

  // Stage is a performance surface: keep the display awake while it
  // plays; release on pause, on leaving Stage, and on unmount.
  useEffect(() => {
    const awake = mode === "stage" && !paused;
    setDisplayAwake(awake).catch(() => {}); // cosmetic failure, never fatal
    return () => {
      if (awake) setDisplayAwake(false).catch(() => {});
    };
  }, [mode, paused]);

  useEffect(() => {
    engine.onEnded((advancedTo) => {
      if (advancedTo) {
        // Engine already handed off gaplessly — sync UI state to it.
        const track = visibleRef.current.find((t) => t.path === advancedTo);
        if (track) {
          setCurrent(track);
          setPosition(0);
          // The handoff may have been into the queue head — consume it.
          setQueue((q) => q.filter((id) => id !== track.id));
          getLyrics(track.path).then(setLyrics).catch(() => setLyrics(null));
          getArtwork(track.path).then(setArtwork).catch(() => setArtwork(null));
          return;
        }
      }
      // No handoff (repeat off at the edge, or preload miss): step the
      // play order as a natural end; nothing next → stop.
      if (!step(1, false)) setPaused(true);
    });
    engine.onError(setError);
    engine.onTimeUpdate(setPosition);
  }, [engine, step]);

  // Position sampling at rAF rate while in Stage mode (lyrics sync).
  useEffect(() => {
    if (mode !== "stage") return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      setPositionMs(engine.positionMs);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [mode, engine]);

  const togglePause = useCallback(() => {
    engine.togglePause();
    setPaused(engine.paused);
  }, [engine]);

  // System Now Playing / media keys via MediaSession; no-op where the
  // WebView doesn't expose it.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    ms.metadata = current
      ? new MediaMetadata({
          title: displayTitle(current),
          artist: current.artist ?? undefined,
          album: current.album ?? undefined,
          artwork: artwork ? [{ src: artwork }] : [],
        })
      : null;
    // Idempotent per system semantics: "play" only resumes, "pause" only pauses.
    ms.setActionHandler("play", () => {
      if (engine.paused) togglePause();
    });
    ms.setActionHandler("pause", () => {
      if (!engine.paused) togglePause();
    });
    ms.setActionHandler("previoustrack", () => step(-1));
    ms.setActionHandler("nexttrack", () => step(1));
    ms.setActionHandler("seekto", (d) => {
      if (d.seekTime != null) {
        engine.seek(d.seekTime);
        setPosition(d.seekTime);
      }
    });
    return () => {
      ms.setActionHandler("play", null);
      ms.setActionHandler("pause", null);
      ms.setActionHandler("previoustrack", null);
      ms.setActionHandler("nexttrack", null);
      ms.setActionHandler("seekto", null);
    };
  }, [current, artwork, togglePause, step, engine]);

  // Control Center progress: position/duration at timeupdate cadence.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !current) return;
    if (!Number.isFinite(engine.duration)) return;
    navigator.mediaSession.setPositionState({
      duration: engine.duration,
      position: Math.min(position, engine.duration),
      playbackRate: 1,
    });
  }, [current, position, engine]);

  // Status-bar (tray) menu, UI half: mirror playback state into the
  // menu labels; failures are cosmetic and must not touch playback.
  useEffect(() => {
    updateTray(current ? displayTitle(current) : null, paused).catch(() => {});
  }, [current, paused]);

  // Tray menu clicks arrive as a `tray-command` event (shell side:
  // src-tauri). Same handlers as the on-screen transport.
  useEffect(() => {
    const unlisten = listen<string>("tray-command", (e) => {
      if (e.payload === "playpause") {
        if (currentRef.current) togglePause();
      } else if (e.payload === "next") step(1);
      else if (e.payload === "prev") step(-1);
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, [togglePause, step]);

  // Keyboard, routed through the uikeys decision table (audit P0): a
  // focused button keeps native Enter/Space activation, sliders keep
  // their arrows, inputs own everything but Escape; ⌘←/→ steps tracks,
  // ←/→ nudges the seek position, CapsLock-S still toggles mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      const zone: KeyZone =
        t instanceof HTMLInputElement
          ? t.type === "range"
            ? "slider"
            : "input"
          : t instanceof HTMLButtonElement
            ? "button"
            : "global";
      const action = routeKey({ key: e.key, meta: e.metaKey || e.ctrlKey, shift: e.shiftKey }, zone);
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
            engine.seek(pos);
            setPosition(pos);
          }
          break;
        case "step-track":
          if (currentRef.current) step(action.offset);
          break;
        case "escape":
          if (selectionRef.current.ids.size > 0) setSelection(emptySelection);
          else setMode("backstage");
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePause, play, step, engine]);

  async function pickAndScan() {
    const dir = await openDialog({ directory: true });
    if (typeof dir !== "string") return;
    await scanDir(dir);
  }

  async function scanDir(dir: string) {
    setScanning(true);
    setError(null);
    setReport(null);
    try {
      setReport(await scanLibrary(dir));
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
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onDragDropEvent((e) => {
      if (e.payload.type === "drop" && e.payload.paths.length > 0) {
        void scanDir(e.payload.paths[0]);
      }
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, []);

  // The scan report is a toast, not a status line: linger, then leave.
  useEffect(() => {
    if (!report) return;
    const t = window.setTimeout(() => setReport(null), 8000);
    return () => window.clearTimeout(t);
  }, [report]);

  const menuItems: MenuItem[] = useMemo(() => {
    if (!menu || menu.targets.length === 0) return [];
    const [first] = menu.targets;
    const ids = menu.targets.map((t) => t.id);
    const inQueue = ids.every((id) => queue.includes(id));
    const queueItem: MenuItem = inQueue
      ? {
          label: ids.length === 1 ? "Remove from queue" : `Remove ${ids.length} from queue`,
          action: () => setQueue((q) => q.filter((id) => !ids.includes(id))),
        }
      : {
          label: ids.length === 1 ? "Play next" : `Play ${ids.length} next`,
          action: () => setQueue((q) => enqueueNext(q, ids)),
        };
    if (menu.targets.length === 1) {
      return [
        { label: "Play", action: () => void play(first) },
        queueItem,
        {
          label: "Reveal in Finder",
          action: () => void revealItemInDir(first.path).catch((e) => setError(String(e))),
        },
        {
          label: "Copy path",
          action: () => void navigator.clipboard.writeText(first.path).catch(() => {}),
        },
      ];
    }
    // Multi-selection: batch actions only (play is inherently single).
    const paths = menu.targets.map((t) => t.path).join("\n");
    return [
      queueItem,
      {
        label: `Copy ${menu.targets.length} paths`,
        action: () => void navigator.clipboard.writeText(paths).catch(() => {}),
      },
    ];
  }, [menu, play, queue]);

  function seekTo(secs: number) {
    engine.seek(secs);
    setPosition(secs);
  }

  /** Commit a scrub drag: one decoder seek on release (audit P0). */
  function commitScrub() {
    if (scrub != null) {
      seekTo(scrub);
      setScrub(null);
    }
  }

  // Engine duration once metadata loads; index duration until then.
  const duration = Number.isFinite(engine.duration)
    ? engine.duration
    : current?.duration_secs ?? NaN;

  if (mode === "stage" && current) {
    return (
      <div className="app stage-mode" onDoubleClick={() => setMode("backstage")}>
        <Stage
          track={current}
          artwork={artwork}
          lyrics={lyrics}
          analyser={engine.analyser}
          positionMs={positionMs}
          duration={duration}
          paused={paused}
          onSeek={seekTo}
          onTogglePause={togglePause}
          onStep={step}
        />
      </div>
    );
  }

  function changeVolume(v: number) {
    engine.volume = v;
    setVolume(v);
    if (v > 0 && muted) setMuted(false);
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    engine.volume = next ? 0 : volume;
  }

  /** Scroll wheel over the volume cluster nudges ±2%. */
  function wheelVolume(e: React.WheelEvent) {
    const v = Math.max(0, Math.min(1, volume + (e.deltaY < 0 ? 0.02 : -0.02)));
    changeVolume(v);
  }

  function onSort(key: SortKey) {
    setSort((s) => toggleSort(s, key));
  }

  return (
    <div className="app">
      <header className={`toolbar ${fullscreen ? "fullscreen" : ""}`} data-tauri-drag-region>
        <h1 className="brand">Ōtori</h1>
        <button onClick={pickAndScan} disabled={scanning}>
          {scanning ? "Scanning…" : "Scan folder…"}
        </button>
        <input
          ref={searchRef}
          className="search"
          type="search"
          placeholder="Filter (⌘F)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="track-count">
          {query ? `${visible.length} / ${tracks.length} tracks` : `${tracks.length} tracks`}
        </span>
        {report && !scanning && (
          <span className="scan-report">
            Added {report.added}, updated {report.updated}
            {report.skipped_icloud.length > 0 && ` · ${report.skipped_icloud.length} in iCloud`}
            {report.unreadable.length > 0 && ` · ${report.unreadable.length} unreadable`}
          </span>
        )}
        <span className="mode-hint">
          {current ? "S → Stage · Space → play/pause" : ""}
        </span>
        <button
          className="icon-btn stage-toggle"
          onClick={() => setMode("stage")}
          disabled={!current}
          aria-label="Enter Stage mode"
          title={current ? "Stage (S)" : "Play a track to enter Stage"}
        >
          <StageIcon />
        </button>
        <button
          className="icon-btn density-toggle"
          onClick={() => setDensity((d) => (d === "comfortable" ? "compact" : "comfortable"))}
          aria-label={density === "comfortable" ? "Compact rows" : "Comfortable rows"}
          title={density === "comfortable" ? "Compact rows" : "Comfortable rows"}
        >
          <DensityIcon compact={density === "compact"} />
        </button>
        <button
          className="icon-btn theme-toggle"
          onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={theme === "dark" ? "Light theme" : "Dark theme"}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      </header>

      {scanning && <div className="scan-progress" role="progressbar" aria-label="Scanning" />}

      {error && (
        <div className="error-bar">
          <span>{error}</span>
          <button className="error-dismiss" onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <main className={`library density-${density}`}>
        {tracks.length === 0 ? (
          <div className="empty">
            <p>Your library is empty.</p>
            <button onClick={pickAndScan} disabled={scanning}>
              {scanning ? "Scanning…" : "Scan a folder"}
            </button>
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
            onPlay={play}
          />
        )}
      </main>

      <footer className="player-bar">
        <div className="transport">
          <button
            className={`mode-btn ${shuffle ? "on" : ""}`}
            onClick={toggleShuffle}
            aria-label="Shuffle"
            aria-pressed={shuffle}
            title={shuffle ? "Shuffle on" : "Shuffle off"}
          >
            <ShuffleIcon />
          </button>
          <button
            className="step-btn"
            onClick={() => step(-1)}
            disabled={!current}
            aria-label="Previous track"
          >
            <PrevIcon />
          </button>
          <button
            className="play-btn"
            onClick={togglePause}
            disabled={!current}
            aria-label={paused ? "Play" : "Pause"}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
          </button>
          <button
            className="step-btn"
            onClick={() => step(1)}
            disabled={!current}
            aria-label="Next track"
          >
            <NextIcon />
          </button>
          <button
            className={`mode-btn ${repeat !== "off" ? "on" : ""}`}
            onClick={() => setRepeat(cycleRepeat)}
            aria-label={`Repeat: ${repeat}`}
            title={`Repeat: ${repeat}`}
          >
            <RepeatIcon one={repeat === "one"} />
          </button>
        </div>

        <div
          className="now-playing"
          onClick={
            current
              ? () => setSelection({ ids: new Set([current.id]), anchor: current.id })
              : undefined
          }
          onDoubleClick={current ? () => setMode("stage") : undefined}
          title={current ? "Click to locate · double-click for Stage" : undefined}
        >
          {current && artwork && <img className="np-art" src={artwork} alt="" />}
          {current ? (
            <div className="np-text">
              <div className="np-title">{displayTitle(current)}</div>
              <div className="np-artist">{current.artist ?? "—"}</div>
            </div>
          ) : (
            <div className="np-title idle">Double-click a track to play</div>
          )}
        </div>

        <div className="seek">
          <span className="time">{formatTime(current ? (scrub ?? position) : null)}</span>
          <input
            type="range"
            min={0}
            max={seekMax(duration)}
            step={0.1}
            value={seekShown(scrub, position, seekMax(duration))}
            disabled={!current || !Number.isFinite(duration)}
            onChange={(e) => setScrub(Number(e.target.value))}
            onPointerUp={commitScrub}
            onKeyUp={commitScrub}
            onBlur={commitScrub}
            aria-label="Seek"
          />
          <button
            className="time time-toggle"
            onClick={() => setShowRemaining((r) => !r)}
            title={showRemaining ? "Show total duration" : "Show time remaining"}
          >
            {current && showRemaining && Number.isFinite(duration)
              ? `-${formatTime(Math.max(0, duration - position))}`
              : formatTime(current ? duration : null)}
          </button>
        </div>

        <div className="volume" onWheel={wheelVolume}>
          <button
            className={`icon-btn mute-btn ${muted ? "muted" : ""}`}
            onClick={toggleMute}
            aria-label={muted ? "Unmute" : "Mute"}
            aria-pressed={muted}
            title={muted ? "Unmute" : "Mute"}
          >
            <VolumeIcon />
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(e) => changeVolume(Number(e.target.value))}
            aria-label="Volume"
          />
        </div>

        <button
          className={`crossfade-toggle ${crossfadeSec ? "on" : ""}`}
          onClick={() => setCrossfadeSec((s) => (s ? 0 : 8))}
          title={
            crossfadeSec
              ? `DJ crossfade: ${crossfadeSec}s (beat-matched when tempos allow)`
              : "DJ crossfade: off (gapless)"
          }
          aria-pressed={crossfadeSec > 0}
        >
          MIX
        </button>

        <Spectrum analyser={engine.analyser} />
      </footer>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  );
}

export default App;
