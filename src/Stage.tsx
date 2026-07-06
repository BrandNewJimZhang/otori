// Stage mode: the performance surface (PRODUCT.md Pillar 2). Large art,
// synced lyrics as subtitles, spectrum as lighting. The degradation
// ladder is handled here: word highlight → line scroll → static text →
// spectrum-only. Every rung is a complete experience.
//
// Beat reactivity: a rAF loop reads band energies and writes CSS custom
// properties on the root — the art pulses and the room lighting breathes
// with the kick, with zero React re-renders on the audio path.
//
// Gel lighting: the cover picks the rig's colors (--gel-floor/--gel-top),
// extracted once per track. Colors are static; position drifts on the
// CSS clock (.stage-gels blobs), and intensity keeps moving on the
// --bass/--highs path above.

import { useEffect, useRef, useState } from "react";
import type { LyricsDoc, TrackRow } from "./types";
import { bandEnergy, Smoother } from "./energy";
import { extractGels } from "./gel";
import { displayTitle } from "./library";
import { formatTime } from "./format";
import { seekMax, seekShown } from "./seekbar";
import { NextIcon, PauseIcon, PlayIcon, PrevIcon } from "./icons";
import { Spectrum } from "./Spectrum";

interface StageProps {
  track: TrackRow;
  artwork: string | null;
  lyrics: LyricsDoc | null;
  analyser: AnalyserNode | null;
  /** Current playback position in ms, sampled by the parent at rAF rate. */
  positionMs: number;
  /** Track length in seconds; NaN until engine metadata loads. */
  duration: number;
  paused: boolean;
  onSeek: (secs: number) => void;
  onTogglePause: () => void;
  onStep: (offset: 1 | -1) => void;
}

/** Index of the last line at or before `positionMs`; -1 before the first. */
function currentLineIndex(doc: LyricsDoc, positionMs: number): number {
  let idx = -1;
  for (let i = 0; i < doc.lines.length; i++) {
    if (doc.lines[i].time_ms <= positionMs) idx = i;
    else break;
  }
  return idx;
}

export function Stage({
  track,
  artwork,
  lyrics,
  analyser,
  positionMs,
  duration,
  paused,
  onSeek,
  onTogglePause,
  onStep,
}: StageProps) {
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const stageRef = useRef<HTMLDivElement>(null);
  const [activeLine, setActiveLine] = useState(-1);
  // Chrome affordance (audit P1): controls + hint surface on mouse
  // movement and retreat after 2s idle — the cursor goes with them.
  const [chromeVisible, setChromeVisible] = useState(true);
  const chromeTimer = useRef<number>(0);
  // Scrub preview (audit P0): seek once on release, not per drag pixel.
  const [scrub, setScrub] = useState<number | null>(null);

  // Beat drive: bass (kick) pulses the art, highs shimmer the lighting.
  // Fast attack / slow release so hits punch and glow decays musically.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !analyser) return;
    const data = new Float32Array(analyser.frequencyBinCount);
    const binHz = analyser.context.sampleRate / analyser.fftSize;
    const bass = new Smoother(0.88);
    const highs = new Smoother(0.82);
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      analyser.getFloatFrequencyData(data);
      const b = bass.push(bandEnergy(data, binHz, 30, 150));
      const h = highs.push(bandEnergy(data, binHz, 4000, 16000));
      stage.style.setProperty("--bass", b.toFixed(3));
      stage.style.setProperty("--highs", h.toFixed(3));
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [analyser]);

  // Gel change-over on track change. No usable color (grayscale cover,
  // no artwork) → drop the overrides so the CSS house gels apply: that
  // rung of the degradation ladder is the current look, already complete.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const clear = () => {
      stage.style.removeProperty("--gel-floor");
      stage.style.removeProperty("--gel-top");
    };
    if (!artwork) {
      clear();
      return;
    }
    let stale = false;
    extractGels(artwork).then((gels) => {
      if (stale) return;
      if (gels) {
        stage.style.setProperty("--gel-floor", gels[0]);
        stage.style.setProperty("--gel-top", gels[1]);
      } else {
        clear();
      }
    });
    return () => {
      stale = true;
    };
  }, [artwork]);

  useEffect(() => {
    const wake = () => {
      setChromeVisible(true);
      window.clearTimeout(chromeTimer.current);
      chromeTimer.current = window.setTimeout(() => setChromeVisible(false), 2000);
    };
    wake();
    window.addEventListener("mousemove", wake);
    return () => {
      window.removeEventListener("mousemove", wake);
      window.clearTimeout(chromeTimer.current);
    };
  }, []);

  const synced = lyrics !== null && lyrics.kind !== "static";
  const lineIdx = synced ? currentLineIndex(lyrics, positionMs) : -1;

  // Scroll only on line change, not every frame.
  useEffect(() => {
    if (lineIdx !== activeLine) setActiveLine(lineIdx);
  }, [lineIdx, activeLine]);

  useEffect(() => {
    if (activeLine < 0) return;
    lineRefs.current[activeLine]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeLine]);

  return (
    <div className={`stage ${chromeVisible ? "" : "idle"}`} ref={stageRef}>
      {/* Full-bleed gel wash: two floor + two top blobs drifting on
          eased X/Y tracks (see .stage-gels in App.css). Order matters:
          App.css anchors by :nth-child — floor low, top high. */}
      <div className="stage-gels" aria-hidden="true">
        <div className="gel-x">
          <div className="gel-blob floor" />
        </div>
        <div className="gel-x">
          <div className="gel-blob floor" />
        </div>
        <div className="gel-x">
          <div className="gel-blob top" />
        </div>
        <div className="gel-x">
          <div className="gel-blob top" />
        </div>
      </div>
      <div className="stage-main">
        <div className="stage-art-wrap">
          <div className="stage-art-pulse">
            {artwork ? (
              <img className="stage-art" src={artwork} alt="" />
            ) : (
              <div className="stage-art placeholder">
                <span>{displayTitle(track).slice(0, 1)}</span>
              </div>
            )}
          </div>
          <div className="stage-track">
            <div className="stage-title">{displayTitle(track)}</div>
            <div className="stage-artist">{track.artist ?? "—"}</div>
            {track.album && <div className="stage-album">{track.album}</div>}
          </div>
        </div>

        {/* Synced lyric lines are seek targets (audit P1), Apple Music-style. */}
        {lyrics ? (
          <div className={`stage-lyrics ${synced ? "synced" : "static"}`}>
            {lyrics.lines.map((line, i) => (
              <div
                key={i}
                ref={(el) => {
                  lineRefs.current[i] = el;
                }}
                className={`lyric-line ${i === activeLine ? "active" : ""} ${
                  synced && i < activeLine ? "past" : ""
                } ${synced ? "seekable" : ""}`}
                onClick={synced ? () => onSeek(line.time_ms / 1000) : undefined}
                onDoubleClick={synced ? (e) => e.stopPropagation() : undefined}
              >
                {line.words && i === activeLine ? (
                  // Word-level: highlight words whose time has come.
                  // Word text keeps its trailing whitespace (core's
                  // parse_word_tags preserves it), so plain concatenation
                  // renders correct spacing for spaced languages.
                  line.words.map((w, wi) => (
                    <span key={wi} className={w.time_ms <= positionMs ? "sung" : ""}>
                      {w.text}
                    </span>
                  ))
                ) : (
                  line.text || "♪"
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="stage-lyrics none">
            <div className="no-lyrics">♪</div>
          </div>
        )}
      </div>

      <div className={`stage-lighting ${chromeVisible ? "" : "chrome-hidden"}`}>
        {/* stopPropagation: rapid control clicks must not hit the
            app-level double-click that exits Stage. */}
        <div className="stage-transport" onDoubleClick={(e) => e.stopPropagation()}>
          <button className="step-btn" onClick={() => onStep(-1)} aria-label="Previous track">
            <PrevIcon />
          </button>
          <button
            className="play-btn"
            onClick={onTogglePause}
            aria-label={paused ? "Play" : "Pause"}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
          </button>
          <button className="step-btn" onClick={() => onStep(1)} aria-label="Next track">
            <NextIcon />
          </button>
        </div>
        <div className="stage-seek" onDoubleClick={(e) => e.stopPropagation()}>
          <span className="time">{formatTime(scrub ?? positionMs / 1000)}</span>
          <input
            type="range"
            min={0}
            max={seekMax(duration)}
            step={0.1}
            value={seekShown(scrub, positionMs / 1000, seekMax(duration))}
            disabled={!Number.isFinite(duration)}
            onChange={(e) => setScrub(Number(e.target.value))}
            onPointerUp={() => {
              if (scrub != null) {
                onSeek(scrub);
                setScrub(null);
              }
            }}
            onBlur={() => {
              if (scrub != null) {
                onSeek(scrub);
                setScrub(null);
              }
            }}
            aria-label="Seek"
          />
          <span className="time">{formatTime(Number.isFinite(duration) ? duration : null)}</span>
        </div>
        <Spectrum analyser={analyser} mirror />
      </div>

      <div className={`stage-hint ${chromeVisible ? "" : "hidden"}`}>
        Esc → Backstage · Space → play/pause
      </div>
    </div>
  );
}
