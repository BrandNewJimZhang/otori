// App shell: Backstage (dense table, management) / Stage (performance)
// with a one-keystroke toggle (PRODUCT.md Pillar 2). Backstage v0's
// known UI debt is tracked for a dedicated fix round — Stage is Cut 3.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getArtwork, getLyrics, listTracks, scanLibrary } from "./ipc";
import { createEngine } from "./playback";
import { Spectrum } from "./Spectrum";
import { Stage } from "./Stage";
import { formatTime } from "./format";
import { NextIcon, PauseIcon, PlayIcon, PrevIcon, VolumeIcon } from "./icons";
import type { LyricsDoc, ScanReport, TrackRow } from "./types";
import "./App.css";

type Mode = "backstage" | "stage";

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
  const engine = useMemo(createEngine, []);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const currentRef = useRef(current);
  currentRef.current = current;

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
        setError(`${track.title ?? track.path}: ${e}`);
      }
    },
    [engine],
  );

  // Step through the current listing order; wraps nothing, just stops.
  const step = useCallback(
    (offset: number) => {
      const list = tracksRef.current;
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

  // Keyboard: Tab/S toggles mode, Space play/pause, Esc leaves Stage.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "Tab" || e.key === "s") {
        e.preventDefault();
        setMode((m) => (m === "backstage" ? "stage" : "backstage"));
      } else if (e.key === " ") {
        e.preventDefault();
        if (currentRef.current) togglePause();
      } else if (e.key === "Escape") {
        setMode("backstage");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePause]);

  async function pickAndScan() {
    const dir = await openDialog({ directory: true });
    if (typeof dir !== "string") return;
    setScanning(true);
    setError(null);
    try {
      setReport(await scanLibrary(dir));
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

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
        <span className="track-count">{tracks.length} tracks</span>
        {report && (
          <span className="scan-report">
            +{report.added} / {report.updated} updated
            {report.skipped_icloud.length > 0 && ` · ${report.skipped_icloud.length} in iCloud`}
            {report.unreadable.length > 0 && ` · ${report.unreadable.length} unreadable`}
          </span>
        )}
        <span className="mode-hint">
          {current ? "Tab → Stage · Space → play/pause" : ""}
        </span>
      </header>

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
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Artist</th>
                <th>Album</th>
                <th className="col-duration">Time</th>
                <th className="col-format">Format</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((t) => (
                <tr
                  key={t.id}
                  className={t.id === current?.id ? "playing" : ""}
                  onDoubleClick={() => play(t)}
                >
                  <td>
                    <span className="row-play" onClick={() => play(t)} aria-label="Play">
                      <PlayIcon />
                    </span>
                    {t.title ?? basename(t.path)}
                  </td>
                  <td>{t.artist ?? "—"}</td>
                  <td>{t.album ?? "—"}</td>
                  <td className="col-duration">{formatTime(t.duration_secs)}</td>
                  <td className="col-format">{t.format}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
          {current ? (
            <>
              <div className="np-title">{current.title ?? basename(current.path)}</div>
              <div className="np-artist">{current.artist ?? "—"}</div>
            </>
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
    </div>
  );
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export default App;
