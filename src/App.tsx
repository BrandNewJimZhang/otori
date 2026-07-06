// App shell: Backstage (dense table, management) / Stage (performance)
// with a one-keystroke toggle (PRODUCT.md Pillar 2). Table presentation
// lives in LibraryTable, view logic in library.ts — App owns state.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { getArtwork, getLyrics, listTracks, scanLibrary } from "./ipc";
import { createEngine } from "./playback";
import { Spectrum } from "./Spectrum";
import { Stage } from "./Stage";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { LibraryTable } from "./LibraryTable";
import { formatTime } from "./format";
import {
  clickSelect,
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
import { NextIcon, PauseIcon, PlayIcon, PrevIcon, VolumeIcon } from "./icons";
import type { LyricsDoc, ScanReport, TrackRow } from "./types";
import "./App.css";

type Mode = "backstage" | "stage";

interface MenuState {
  x: number;
  y: number;
  track: TrackRow;
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
  const [volume, setVolume] = useState(1);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortSpec | null>(null);
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const engine = useMemo(createEngine, []);
  const searchRef = useRef<HTMLInputElement>(null);

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

  const refresh = useCallback(() => {
    listTracks().then(setTracks).catch((e) => setError(String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  const play = useCallback(
    async (track: TrackRow) => {
      setError(null);
      try {
        await engine.play(track.path);
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

  // Step through the visible listing order; wraps nothing, just stops.
  const step = useCallback(
    (offset: number) => {
      const list = visibleRef.current;
      const cur = currentRef.current;
      const idx = list.findIndex((t) => t.id === cur?.id);
      const next = idx >= 0 ? list[idx + offset] : undefined;
      if (next) void play(next);
      return Boolean(next);
    },
    [play],
  );

  useEffect(() => {
    engine.onEnded(() => {
      if (!step(1)) setPaused(true);
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

  // Keyboard: Tab/S mode, Space play/pause, ↑↓ select, Enter play,
  // ⌘F search, Esc dismiss (search → selection → Stage).
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
      if (e.key === "Tab" || e.key === "s") {
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
    if (!menu) return [];
    return [
      { label: "Play", action: () => void play(menu.track) },
      {
        label: "Reveal in Finder",
        action: () => void revealItemInDir(menu.track.path).catch((e) => setError(String(e))),
      },
      {
        label: "Copy path",
        action: () => void navigator.clipboard.writeText(menu.track.path).catch(() => {}),
      },
    ];
  }, [menu, play]);

  if (mode === "stage" && current) {
    return (
      <div className="app stage-mode" onDoubleClick={() => setMode("backstage")}>
        <Stage
          track={current}
          artwork={artwork}
          lyrics={lyrics}
          analyser={engine.analyser}
          positionMs={positionMs}
        />
      </div>
    );
  }

  function seekTo(secs: number) {
    engine.seek(secs);
    setPosition(secs);
  }

  function changeVolume(v: number) {
    engine.volume = v;
    setVolume(v);
  }

  function onSort(key: SortKey) {
    setSort((s) => toggleSort(s, key));
  }

  // Engine duration once metadata loads; index duration until then.
  const duration = Number.isFinite(engine.duration)
    ? engine.duration
    : current?.duration_secs ?? NaN;

  return (
    <div className="app">
      <header className="toolbar" data-tauri-drag-region>
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
          {current ? "Tab → Stage · Space → play/pause" : ""}
        </span>
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
              setMenu({ x: e.clientX, y: e.clientY, track });
            }}
            onPlay={play}
          />
        )}
      </main>

      <footer className="player-bar">
        <div className="transport">
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
