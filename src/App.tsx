// Backstage v0: library table + scan + playback bar with live spectrum.
// Stage mode (large art, lyrics) is Cut 3; this file will split when it
// grows a second mode.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listTracks, scanLibrary } from "./ipc";
import { createEngine } from "./playback";
import { Spectrum } from "./Spectrum";
import type { ScanReport, TrackRow } from "./types";
import "./App.css";

function App() {
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [current, setCurrent] = useState<TrackRow | null>(null);
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
      } catch (e) {
        setError(`${track.title ?? track.path}: ${e}`);
      }
    },
    [engine],
  );

  useEffect(() => {
    engine.onEnded(() => {
      // Auto-advance to the next row in the current listing order.
      const list = tracksRef.current;
      const cur = currentRef.current;
      const idx = list.findIndex((t) => t.id === cur?.id);
      if (idx >= 0 && idx + 1 < list.length) void play(list[idx + 1]);
      else setPaused(true);
    });
    engine.onError(setError);
  }, [engine, play]);

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

  function togglePause() {
    engine.togglePause();
    setPaused(engine.paused);
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
