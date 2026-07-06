// App shell: Backstage (dense table, management) / Stage (performance)
// with a one-keystroke toggle (PRODUCT.md Pillar 2). Table presentation
// lives in LibraryTable, view logic in library.ts — App owns state.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { getArtwork, getLyrics, listTracks, scanLibrary, updateTray } from "./ipc";
import { createEngine } from "./playback";
import { Spectrum } from "./Spectrum";
import { Stage } from "./Stage";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { LibraryTable } from "./LibraryTable";
import { formatTime } from "./format";
import {
  clickSelect,
  contextTargets,
  displayTitle,
  emptySelection,
  filterTracks,
  sortTracks,
  stepSelect,
  toggleSort,
  type Selection,
  type SortKey,
  type SortSpec,
} from "./library";
import { cycleRepeat, effectiveOrder, nextId, shuffledIds, type RepeatMode } from "./playorder";
import {
  MoonIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  RepeatIcon,
  ShuffleIcon,
  SunIcon,
  VolumeIcon,
} from "./icons";
import { loadPrefs, savePrefs, type Theme } from "./prefs";
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
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortSpec | null>(initialPrefs.sort);
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [menu, setMenu] = useState<MenuState | null>(null);
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

  const refresh = useCallback(() => {
    listTracks().then(setTracks).catch((e) => setError(String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  // L5 coexistence, UI half (AGENTS.md "Coexistence with the GUI"): the
  // shell emits `library-changed` when an external writer (CLI/agent)
  // commits; re-fetch so the table reflects it within ~1s.
  useEffect(() => {
    const unlisten = listen("library-changed", refresh);
    return () => {
      unlisten.then((off) => off());
    };
  }, [refresh]);

  // Apply the persisted volume to the engine once it exists.
  useEffect(() => {
    engine.volume = initialPrefs.volume;
  }, [engine]);

  useEffect(() => {
    savePrefs(localStorage, { volume, sort, shuffle, repeat, theme });
  }, [volume, sort, shuffle, repeat, theme]);

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
  const step = useCallback(
    (offset: 1 | -1, manual = true) => {
      const list = visibleRef.current;
      const cur = currentRef.current;
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
  // (gapless). "Next" follows the play order — shuffle permutation and
  // repeat included (repeat-one preloads the same file for a gapless
  // replay) — not merely the next visible row.
  useEffect(() => {
    const visibleIds = visible.map((t) => t.id);
    const order = shuffle ? effectiveOrder(visibleIds, shuffleOrderRef.current) : visibleIds;
    const id = nextId(order, current?.id ?? null, 1, repeat, false);
    const next = id != null ? visible.find((t) => t.id === id) : undefined;
    engine.preloadNext(next ? { path: next.path, replaygainDb: next.replaygain_db } : null);
  }, [engine, visible, current, shuffle, repeat]);

  useEffect(() => {
    engine.onEnded((advancedTo) => {
      if (advancedTo) {
        // Engine already handed off gaplessly — sync UI state to it.
        const track = visibleRef.current.find((t) => t.path === advancedTo);
        if (track) {
          setCurrent(track);
          setPosition(0);
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

  // Keyboard: S toggles mode (Tab stays with the focus system),
  // Space play/pause, ↑↓ select, Enter play, ⌘F search,
  // Esc dismiss (search → selection → Stage).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.target instanceof HTMLInputElement) {
        // Esc leaves the search box; everything else belongs to the input.
        if (e.key === "Escape") (e.target as HTMLInputElement).blur();
        return;
      }
      if (e.key === "s") {
        e.preventDefault();
        setMode((m) => (m === "backstage" ? "stage" : "backstage"));
      } else if (e.key === " ") {
        e.preventDefault();
        if (currentRef.current) togglePause();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelection((sel) => stepSelect(sel, visibleRef.current, e.key === "ArrowDown" ? 1 : -1));
      } else if (e.key === "Enter") {
        const sel = selectionRef.current;
        const track = visibleRef.current.find((t) => sel.ids.has(t.id));
        if (track) void play(track);
      } else if (e.key === "Escape") {
        if (selectionRef.current.ids.size > 0) setSelection(emptySelection);
        else setMode("backstage");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePause, play]);

  async function pickAndScan() {
    const dir = await openDialog({ directory: true });
    if (typeof dir !== "string") return;
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

  const menuItems: MenuItem[] = useMemo(() => {
    if (!menu || menu.targets.length === 0) return [];
    const [first] = menu.targets;
    if (menu.targets.length === 1) {
      return [
        { label: "Play", action: () => void play(first) },
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
      {
        label: `Copy ${menu.targets.length} paths`,
        action: () => void navigator.clipboard.writeText(paths).catch(() => {}),
      },
    ];
  }, [menu, play]);

  function seekTo(secs: number) {
    engine.seek(secs);
    setPosition(secs);
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
          onSeek={seekTo}
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

      <main className="library">
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
            selection={selection}
            sort={sort}
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

        <div className="now-playing">
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
          <span className="time">{formatTime(current ? position : null)}</span>
          <input
            type="range"
            min={0}
            max={Number.isFinite(duration) ? duration : 0}
            step={0.1}
            value={Math.min(position, Number.isFinite(duration) ? duration : 0)}
            disabled={!current || !Number.isFinite(duration)}
            onChange={(e) => seekTo(Number(e.target.value))}
            aria-label="Seek"
          />
          <span className="time">{formatTime(current ? duration : null)}</span>
        </div>

        <div className="volume">
          <VolumeIcon />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => changeVolume(Number(e.target.value))}
            aria-label="Volume"
          />
        </div>

        <Spectrum analyser={engine.analyser} />
      </footer>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  );
}

export default App;
