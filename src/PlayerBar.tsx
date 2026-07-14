// Player bar: transport, now-playing, seek, volume, queue toggle, MIX
// cluster, spectrum. Owns its presentation-local state (scrub preview,
// mute, remaining-time display, MIX popover); playback state and the
// engine stay in App — this dispatches intents.

import { useEffect, useState } from "react";
import { formatTime } from "./format";
import {
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  QueueIcon,
  RepeatIcon,
  ShuffleIcon,
  StageIcon,
  VolumeIcon,
} from "./icons";
import { displayTitle } from "./library";
import type { RepeatMode } from "./playorder";
import { seekMax, seekShown, sliderFill } from "./seekbar";
import { CROSSFADE_SLIDER_MAX, crossfadeFromSlider } from "./settings";
import { Spectrum } from "./Spectrum";
import type { TrackRow } from "./types";

interface Props {
  current: TrackRow | null;
  artwork: string | null;
  paused: boolean;
  position: number;
  duration: number;
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
  queueCount: number;
  queueOpen: boolean;
  crossfadeSec: number;
  analyser: AnalyserNode | null;
  onToggleShuffle(): void;
  onStep(offset: 1 | -1): void;
  onTogglePause(): void;
  onCycleRepeat(): void;
  onEnterStage(): void;
  /** Click on the title: select the playing row in the table. */
  onLocate(track: TrackRow): void;
  /** Commit a seek (one decoder seek per scrub release — audit P0). */
  onSeek(secs: number): void;
  /** Persisted volume change (engine + prefs). */
  onVolume(v: number): void;
  /** Engine-only volume write for mute/unmute; prefs keep the level. */
  onMuteVolume(effective: number): void;
  onToggleQueue(): void;
  onCrossfadeSec(secs: number): void;
}

export function PlayerBar({
  current,
  artwork,
  paused,
  position,
  duration,
  shuffle,
  repeat,
  volume,
  queueCount,
  queueOpen,
  crossfadeSec,
  analyser,
  onToggleShuffle,
  onStep,
  onTogglePause,
  onCycleRepeat,
  onEnterStage,
  onLocate,
  onSeek,
  onVolume,
  onMuteVolume,
  onToggleQueue,
  onCrossfadeSec,
}: Props) {
  // Scrub preview (audit P0): thumb position while dragging the seek
  // slider; the decoder seek fires once on release, not per pixel.
  const [scrub, setScrub] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [showRemaining, setShowRemaining] = useState(false);
  // MIX popover (audit r5 P1): the wheel-to-adjust gesture was
  // undiscoverable; right-click opens an explicit slider.
  const [mixPopover, setMixPopover] = useState(false);

  // MIX popover dismissal: any click outside the cluster, or Escape.
  useEffect(() => {
    if (!mixPopover) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".mix-cluster")) setMixPopover(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMixPopover(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [mixPopover]);

  /** Commit a scrub drag: one decoder seek on release (audit P0). */
  function commitScrub() {
    if (scrub != null) {
      onSeek(scrub);
      setScrub(null);
    }
  }

  function changeVolume(v: number) {
    onVolume(v);
    if (v > 0 && muted) setMuted(false);
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    onMuteVolume(next ? 0 : volume);
  }

  /** Scroll wheel over the volume cluster nudges ±2%. */
  function wheelVolume(e: React.WheelEvent) {
    const v = Math.max(0, Math.min(1, volume + (e.deltaY < 0 ? 0.02 : -0.02)));
    changeVolume(v);
  }

  return (
    <footer className="player-bar">
      <div className="transport">
        <button
          className={`mode-btn ${shuffle ? "on" : ""}`}
          onClick={onToggleShuffle}
          aria-label="Shuffle"
          aria-pressed={shuffle}
          data-tip={shuffle ? "Shuffle on" : "Shuffle off"}
        >
          <ShuffleIcon />
        </button>
        <button
          className="step-btn"
          onClick={() => onStep(-1)}
          disabled={!current}
          aria-label="Previous track"
        >
          <PrevIcon />
        </button>
        <button
          className="play-btn"
          onClick={onTogglePause}
          disabled={!current}
          aria-label={paused ? "Play" : "Pause"}
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
        </button>
        <button
          className="step-btn"
          onClick={() => onStep(1)}
          disabled={!current}
          aria-label="Next track"
        >
          <NextIcon />
        </button>
        <button
          className={`mode-btn ${repeat !== "off" ? "on" : ""}`}
          onClick={onCycleRepeat}
          aria-label={`Repeat: ${repeat}`}
          data-tip={`Repeat: ${repeat}`}
        >
          <RepeatIcon one={repeat === "one"} />
        </button>
      </div>

      <div className="now-playing">
        {current && artwork && (
          <button
            className="np-art-btn"
            onClick={onEnterStage}
            aria-label="Enter Stage mode"
            data-tip="Stage (S)"
          >
            <img className="np-art" src={artwork} alt="" />
            <span className="np-art-overlay" aria-hidden>
              <StageIcon />
            </span>
          </button>
        )}
        {current ? (
          <button className="np-text" onClick={() => onLocate(current)} data-tip="Locate in library">
            <div className="np-title">{displayTitle(current)}</div>
            <div className="np-artist">{current.artist ?? "—"}</div>
          </button>
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
          style={
            {
              "--fill": sliderFill(seekShown(scrub, position, seekMax(duration)), seekMax(duration)),
            } as React.CSSProperties
          }
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
          aria-label={showRemaining ? "Show total duration" : "Show time remaining"}
          data-tip={showRemaining ? "Show total duration" : "Show time remaining"}
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
          data-tip={muted ? "Unmute" : "Mute"}
        >
          <VolumeIcon />
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          style={{ "--fill": sliderFill(muted ? 0 : volume, 1) } as React.CSSProperties}
          onChange={(e) => changeVolume(Number(e.target.value))}
          aria-label="Volume"
        />
      </div>

      <button
        className={`icon-btn queue-toggle ${queueOpen ? "on" : ""}`}
        onClick={onToggleQueue}
        aria-label="Play queue"
        aria-pressed={queueOpen}
        data-tip={queueCount > 0 ? `Up next (${queueCount} queued)` : "Up next"}
      >
        <QueueIcon />
        {queueCount > 0 && <span className="queue-count">{queueCount}</span>}
      </button>

      <div className="mix-cluster">
        <button
          className={`crossfade-toggle ${crossfadeSec ? "on" : ""}`}
          onClick={() => onCrossfadeSec(crossfadeSec ? 0 : 8)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMixPopover((v) => !v);
          }}
          onWheel={(e) => {
            // Wheel adjusts the fade length 2–16s while enabled.
            if (crossfadeSec) {
              onCrossfadeSec(
                Math.max(2, Math.min(CROSSFADE_SLIDER_MAX, crossfadeSec + (e.deltaY < 0 ? 1 : -1))),
              );
            }
          }}
          data-tip={
            crossfadeSec
              ? `DJ crossfade: ${crossfadeSec}s · right-click / scroll to adjust`
              : "DJ crossfade: off (gapless) · right-click to configure"
          }
          aria-pressed={crossfadeSec > 0}
        >
          MIX{crossfadeSec ? ` ${crossfadeSec}s` : ""}
        </button>
        {mixPopover && (
          <div className="mix-popover">
            <label>
              Crossfade {crossfadeSec ? `${crossfadeSec}s` : "off"}
              <input
                type="range"
                min={0}
                max={CROSSFADE_SLIDER_MAX}
                step={1}
                value={crossfadeSec}
                style={{ "--fill": sliderFill(crossfadeSec, CROSSFADE_SLIDER_MAX) } as React.CSSProperties}
                onChange={(e) => {
                  // 0 disables; 1 rounds up to the 2s floor.
                  onCrossfadeSec(crossfadeFromSlider(Number(e.target.value)));
                }}
                aria-label="Crossfade length"
              />
            </label>
            <span className="mix-popover-hint">beat-matched when tempos allow</span>
          </div>
        )}
      </div>

      <Spectrum analyser={analyser} paused={paused} />
    </footer>
  );
}
