// Stage mode: the performance surface (PRODUCT.md Pillar 2). Large art,
// synced lyrics as subtitles, spectrum as lighting. The degradation
// ladder is handled here: word highlight → line scroll → static text →
// spectrum-only. Every rung is a complete experience.
//
// Lyric sync: all timing comparisons go through the lyric clock
// (lyrictime.ts) — engine position minus output latency, plus the
// perceptual lead, minus the user's per-track nudge. Never compare
// lyric timestamps against raw positionMs.
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
import type { RepeatMode } from "./playorder";
import { bandEnergy, Smoother } from "./energy";
import { extractGels } from "./gel";
import { displayTitle } from "./library";
import { FOLLOW_GRACE_MS, shouldFollow } from "./lyricfollow";
import { formatTime } from "./format";
import { seekMax, seekShown } from "./seekbar";
import { NextIcon, PauseIcon, PlayIcon, PrevIcon, RepeatIcon, ShuffleIcon } from "./icons";
import { currentLineIndex, lyricClock, wordProgress } from "./lyrictime";
import { Spectrum } from "./Spectrum";
import { shouldKeepDrawing } from "./vizidle";

interface StageProps {
  track: TrackRow;
  artwork: string | null;
  lyrics: LyricsDoc | null;
  analyser: AnalyserNode | null;
  /** Current playback position in ms, sampled by the parent at rAF rate. */
  positionMs: number;
  /** Audio-graph output latency in ms (subtracted by the lyric clock). */
  outputLatencyMs: number;
  /** Per-track sync nudge in ms ([ / ] keys in App, persisted). */
  lyricsOffsetMs: number;
  /** Track length in seconds; NaN until engine metadata loads. */
  duration: number;
  paused: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  onSeek: (secs: number) => void;
  onTogglePause: () => void;
  onStep: (offset: 1 | -1) => void;
  onToggleShuffle: () => void;
  onCycleRepeat: () => void;
}

/** Last word of the last line has no successor to bound its wipe; a
    sung phrase tail rarely outlives this. */
const LAST_WORD_SPAN_MS = 5000;
/** Offset HUD lingers this long after a nudge. */
const OFFSET_HUD_MS = 1500;

export function Stage({
  track,
  artwork,
  lyrics,
  analyser,
  positionMs,
  outputLatencyMs,
  lyricsOffsetMs,
  duration,
  paused,
  shuffle,
  repeat,
  onSeek,
  onTogglePause,
  onStep,
  onToggleShuffle,
  onCycleRepeat,
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
  // Transient sync badge: shows on [ / ] nudges, not on mount.
  const [offsetHud, setOffsetHud] = useState(false);
  const offsetHudTimer = useRef<number>(0);
  const offsetSeen = useRef(lyricsOffsetMs);

  // Commit a scrub: pointer release, keyboard nudge release (audit R4:
  // arrows moved the preview but never sought until blur), or blur.
  const commitScrub = () => {
    if (scrub != null) {
      onSeek(scrub);
      setScrub(null);
    }
  };

  // Beat drive: bass (kick) pulses the art, highs shimmer the lighting.
  // Fast attack / slow release so hits punch and glow decays musically.
  // Paused audio decays to silence; once the smoothed pulses settle the
  // loop stops scheduling frames (vizidle) and the paused-flip below
  // restarts it on resume.
  const beatPausedRef = useRef(paused);
  const beatResumeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !analyser) return;
    const data = new Float32Array(analyser.frequencyBinCount);
    const binHz = analyser.context.sampleRate / analyser.fftSize;
    const bass = new Smoother(0.88);
    const highs = new Smoother(0.82);
    let raf = 0;
    const tick = () => {
      analyser.getFloatFrequencyData(data);
      const b = bass.push(bandEnergy(data, binHz, 30, 150));
      const h = highs.push(bandEnergy(data, binHz, 4000, 16000));
      stage.style.setProperty("--bass", b.toFixed(3));
      stage.style.setProperty("--highs", h.toFixed(3));
      raf = shouldKeepDrawing(beatPausedRef.current, Math.max(b, h))
        ? requestAnimationFrame(tick)
        : 0;
    };
    beatResumeRef.current = () => {
      if (raf === 0) tick(); // guard: never stack a second loop
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      beatResumeRef.current = null;
    };
  }, [analyser]);

  useEffect(() => {
    beatPausedRef.current = paused;
    if (!paused) beatResumeRef.current?.();
  }, [paused]);

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

  // Surface the sync badge only when the offset actually changes.
  useEffect(() => {
    if (offsetSeen.current === lyricsOffsetMs) return;
    offsetSeen.current = lyricsOffsetMs;
    setOffsetHud(true);
    window.clearTimeout(offsetHudTimer.current);
    offsetHudTimer.current = window.setTimeout(() => setOffsetHud(false), OFFSET_HUD_MS);
    return () => window.clearTimeout(offsetHudTimer.current);
  }, [lyricsOffsetMs]);

  const synced = lyrics !== null && lyrics.kind !== "static";
  const clockMs = lyricClock(positionMs, outputLatencyMs, lyricsOffsetMs);
  const lineIdx = synced ? currentLineIndex(lyrics, clockMs) : -1;

  // Manual lyric browsing (audit R4): a wheel/touch scroll pauses the
  // auto-follow so reading ahead isn't yanked back on the next line;
  // it resumes after the grace period, re-centering immediately.
  const lastManualScroll = useRef<number | null>(null);
  const followResume = useRef<number>(0);
  const lineIdxRef = useRef(-1);
  lineIdxRef.current = lineIdx;
  const markManualScroll = () => {
    lastManualScroll.current = performance.now();
    // Re-center when the grace expires, even without a line change.
    window.clearTimeout(followResume.current);
    followResume.current = window.setTimeout(() => {
      lastManualScroll.current = null;
      lineRefs.current[lineIdxRef.current]?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, FOLLOW_GRACE_MS);
  };
  useEffect(() => () => window.clearTimeout(followResume.current), []);

  // Scroll only on line change, not every frame.
  useEffect(() => {
    if (lineIdx !== activeLine) setActiveLine(lineIdx);
  }, [lineIdx, activeLine]);

  // scrollIntoView keeps layout simple; a transform-driven list is the
  // upgrade path if smooth-scroll cadence ever bothers on WKWebView.
  useEffect(() => {
    if (activeLine < 0) return;
    if (!shouldFollow(performance.now(), lastManualScroll.current)) return;
    lineRefs.current[activeLine]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeLine]);

  /** Where the active line's word wipe ends: the next line's start. */
  function lineEndMs(i: number): number {
    const lines = lyrics!.lines;
    if (i + 1 < lines.length) return lines[i + 1].time_ms;
    const words = lines[i].words;
    const lastStart = words?.length ? words[words.length - 1].time_ms : lines[i].time_ms;
    return lastStart + LAST_WORD_SPAN_MS;
  }

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

          {/* Apple Music-style: transport + seek live under the track
              meta in the left column, not on a bottom bar. They still
              retreat with the chrome. stopPropagation: rapid control
              clicks must not hit the app-level double-click that exits
              Stage. */}
          <div className={`stage-controls ${chromeVisible ? "" : "chrome-hidden"}`}>
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
                onPointerUp={commitScrub}
                onKeyUp={commitScrub}
                onBlur={commitScrub}
                aria-label="Seek"
              />
              <span className="time">
                {formatTime(Number.isFinite(duration) ? duration : null)}
              </span>
            </div>
            <div className="stage-transport" onDoubleClick={(e) => e.stopPropagation()}>
              <button
                className={`mode-btn ${shuffle ? "on" : ""}`}
                onClick={onToggleShuffle}
                aria-label="Shuffle"
                aria-pressed={shuffle}
                title={shuffle ? "Shuffle on" : "Shuffle off"}
              >
                <ShuffleIcon />
              </button>
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
              <button
                className={`mode-btn ${repeat !== "off" ? "on" : ""}`}
                onClick={onCycleRepeat}
                aria-label={`Repeat: ${repeat}`}
                title={`Repeat: ${repeat}`}
              >
                <RepeatIcon one={repeat === "one"} />
              </button>
            </div>
          </div>
        </div>

        {/* Synced lyric lines are seek targets (audit P1), Apple Music-style. */}
        {lyrics ? (
          <div
            className={`stage-lyrics ${synced ? "synced" : "static"}`}
            // Wheel = the user is reading; pause the follow. Clicking a
            // line to seek is intent to jump — resume immediately below.
            onWheel={synced ? markManualScroll : undefined}
          >
            {lyrics.lines.map((line, i) => {
              const active = i === activeLine;
              // Distance from the active line drives the depth-of-field
              // fade (see .lyric-line[data-dist] in App.css).
              const dist = synced && activeLine >= 0 ? Math.min(Math.abs(i - activeLine), 4) : 0;
              return (
                <div
                  key={i}
                  ref={(el) => {
                    lineRefs.current[i] = el;
                  }}
                  data-dist={dist}
                  className={`lyric-line ${active ? "active" : ""} ${
                    synced && i < activeLine ? "past" : ""
                  } ${synced ? "seekable" : ""}`}
                  onClick={
                    synced
                      ? () => {
                          // A seek is a jump back into the song: cancel the
                          // browsing pause so the follow re-engages at once.
                          window.clearTimeout(followResume.current);
                          lastManualScroll.current = null;
                          // Undo the render-time offset so the sung audio
                          // lands where the user pointed.
                          onSeek(Math.max(0, line.time_ms + lyricsOffsetMs) / 1000);
                        }
                      : undefined
                  }
                  onDoubleClick={synced ? (e) => e.stopPropagation() : undefined}
                >
                  {line.words && active ? (
                    // Word-level: continuous karaoke wipe. Each word's
                    // --fill drives a text-clipped gradient; trailing
                    // whitespace survives from core's parse_word_tags,
                    // so plain concatenation spaces correctly.
                    wordProgress(line.words, clockMs, lineEndMs(i)).map((p, wi) => (
                      <span
                        key={wi}
                        className="w"
                        style={{ "--fill": `${(p * 100).toFixed(1)}%` } as React.CSSProperties}
                      >
                        {line.words![wi].text}
                      </span>
                    ))
                  ) : (
                    line.text || "♪"
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="stage-lyrics none">
            <div className="no-lyrics">♪</div>
          </div>
        )}
      </div>

      <div className="stage-lighting">
        <Spectrum analyser={analyser} paused={paused} mirror />
      </div>

      <div className={`stage-offset-hud ${offsetHud ? "" : "hidden"}`}>
        Lyrics {lyricsOffsetMs >= 0 ? "+" : ""}
        {(lyricsOffsetMs / 1000).toFixed(1)}s
      </div>

      <div className={`stage-hint ${chromeVisible ? "" : "hidden"}`}>
        Esc → Backstage · Space → play/pause
        {synced ? " · [ ] → lyric sync" : ""}
      </div>
    </div>
  );
}
