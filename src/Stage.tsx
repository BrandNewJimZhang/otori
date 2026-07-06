// Stage mode: the performance surface (PRODUCT.md Pillar 2). Large art,
// synced lyrics as subtitles, spectrum as lighting. The degradation
// ladder is handled here: word highlight → line scroll → static text →
// spectrum-only. Every rung is a complete experience.

import { useEffect, useRef, useState } from "react";
import type { LyricsDoc, TrackRow } from "./types";
import { displayTitle } from "./library";
import { Spectrum } from "./Spectrum";

interface StageProps {
  track: TrackRow;
  artwork: string | null;
  lyrics: LyricsDoc | null;
  analyser: AnalyserNode | null;
  /** Current playback position in ms, sampled by the parent at rAF rate. */
  positionMs: number;
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

export function Stage({ track, artwork, lyrics, analyser, positionMs }: StageProps) {
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [activeLine, setActiveLine] = useState(-1);
  // Exit affordance: visible on mouse movement, fades after 2s idle.
  const [hintVisible, setHintVisible] = useState(true);
  const hintTimer = useRef<number>(0);

  useEffect(() => {
    const wake = () => {
      setHintVisible(true);
      window.clearTimeout(hintTimer.current);
      hintTimer.current = window.setTimeout(() => setHintVisible(false), 2000);
    };
    wake();
    window.addEventListener("mousemove", wake);
    return () => {
      window.removeEventListener("mousemove", wake);
      window.clearTimeout(hintTimer.current);
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
    <div className="stage">
      <div className="stage-main">
        <div className="stage-art-wrap">
          {artwork ? (
            <img className="stage-art" src={artwork} alt="" />
          ) : (
            <div className="stage-art placeholder">
              <span>{displayTitle(track).slice(0, 1)}</span>
            </div>
          )}
          <div className="stage-track">
            <div className="stage-title">{displayTitle(track)}</div>
            <div className="stage-artist">{track.artist ?? "—"}</div>
            {track.album && <div className="stage-album">{track.album}</div>}
          </div>
        </div>

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
                }`}
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

      <div className="stage-lighting">
        <Spectrum analyser={analyser} />
      </div>

      <div className={`stage-hint ${hintVisible ? "" : "hidden"}`}>
        Esc → Backstage · Space → play/pause
      </div>
    </div>
  );
}
