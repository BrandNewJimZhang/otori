// App shell: Backstage (dense table, management) / Stage (performance)
// with a one-keystroke toggle (PRODUCT.md Pillar 2). Backstage v0's
// known UI debt is tracked for a dedicated fix round — Stage is Cut 3.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getArtwork, getLyrics, listTracks, scanLibrary } from "./ipc";
import { createEngine } from "./playback";
import { Spectrum } from "./Spectrum";
import { Stage } from "./Stage";
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

  useEffect(() => {
    engine.onEnded(() => {
      const list = tracksRef.current;
      const cur = currentRef.current;
      const idx = list.findIndex((t) => t.id === cur?.id);
      if (idx >= 0 && idx + 1 < list.length) void play(list[idx + 1]);
      else setPaused(true);
    });
    engine.onError(setError);
  }, [engine, play]);

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

  return (
    <div className="app">
      <header className="toolbar">
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

      {error && <div className="error-bar">{error}</div>}

      <main className="library">
        {tracks.length === 0 ? (
          <div className="empty">Scan a folder to build your library.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Artist</th>
                <th>Album</th>
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
                  <td>{t.title ?? basename(t.path)}</td>
                  <td>{t.artist ?? "—"}</td>
                  <td>{t.album ?? "—"}</td>
                  <td className="col-format">{t.format}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>

      <footer className="player-bar">
        <button className="play-btn" onClick={togglePause} disabled={!current}>
          {paused ? "▶" : "⏸"}
        </button>
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
        <Spectrum analyser={engine.analyser} />
      </footer>
    </div>
  );
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export default App;
