// Tray mini player: the panel that drops down from the status-bar icon
// (src-tauri toggle_mini_panel). Pure mirror + remote — the playback
// engine lives in the main window; this window renders `np-state` /
// `np-pos` broadcasts and sends commands back over the same
// `tray-command` / `mini-seek` events the transport already handles.

import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { formatTime } from "./format";
import { seekMax, seekShown, sliderFill } from "./seekbar";
import { NextIcon, PauseIcon, PlayIcon, PrevIcon } from "./icons";
import type { NpState } from "./npstate";
import "./App.css";

const IDLE: NpState = { title: null, artist: null, paused: true, artwork: null, durationSecs: null };

export function MiniPlayer() {
  const [np, setNp] = useState<NpState>(IDLE);
  const [position, setPosition] = useState(0);
  // Scrub preview, same semantics as the main seek bar (audit P0):
  // drag previews locally, one seek commits on release.
  const [scrub, setScrub] = useState<number | null>(null);

  useEffect(() => {
    const unState = listen<NpState>("np-state", (e) => setNp(e.payload));
    const unPos = listen<number>("np-pos", (e) => setPosition(e.payload));
    // Pull the current snapshot: the panel may mount/show long after
    // the main window last broadcast.
    void emit("np-refresh");
    return () => {
      unState.then((off) => off());
      unPos.then((off) => off());
    };
  }, []);

  const playing = np.title != null;
  const max = seekMax(np.durationSecs ?? NaN);
  const shown = seekShown(scrub, position, max);

  function commitScrub() {
    if (scrub != null) {
      void emit("mini-seek", scrub);
      setPosition(scrub);
      setScrub(null);
    }
  }

  return (
    <div className="mini-panel" data-testid="mini-panel">
      {np.artwork ? (
        <img className="mini-art" src={np.artwork} alt="" />
      ) : (
        <div className="mini-art mini-art-empty" aria-hidden>
          ♪
        </div>
      )}
      <div className="mini-body">
        <div className="mini-title">{np.title ?? "Nothing playing"}</div>
        <div className="mini-artist">{playing ? np.artist ?? "—" : "Ōtori"}</div>
        <div className="mini-seek">
          <span className="mini-time">{formatTime(playing ? shown : null)}</span>
          <input
            type="range"
            min={0}
            max={max}
            step={0.1}
            value={shown}
            disabled={!playing || max <= 0}
            style={{ "--fill": sliderFill(shown, max) } as React.CSSProperties}
            onChange={(e) => setScrub(Number(e.target.value))}
            onPointerUp={commitScrub}
            onKeyUp={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") commitScrub();
            }}
            aria-label="Seek"
          />
          <span className="mini-time">{formatTime(playing ? max || null : null)}</span>
        </div>
        <div className="mini-transport">
          <button
            onClick={() => void emit("tray-command", "prev")}
            disabled={!playing}
            aria-label="Previous"
          >
            <PrevIcon />
          </button>
          <button
            className="mini-play"
            onClick={() => void emit("tray-command", "playpause")}
            disabled={!playing}
            aria-label={np.paused ? "Play" : "Pause"}
          >
            {np.paused ? <PlayIcon /> : <PauseIcon />}
          </button>
          <button
            onClick={() => void emit("tray-command", "next")}
            disabled={!playing}
            aria-label="Next"
          >
            <NextIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
