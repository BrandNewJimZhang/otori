// Track beat analysis service: decode → onset envelope → analysis,
// cached per path. Runs on the WebView's decodeAudioData (off-main
// decode). Two consumers with different needs:
//   - beatGridFor: head-of-track grid (bpm + phase) for imminent
//     crossfade planning; 60s is enough to lock a mix-in tempo.
//   - tempoAnalysisFor: whole-track windowed verdict for the BPM
//     column — catches mid-track tempo changes (soflan) the head
//     analysis can't see.
// Never blocks playback: an unanalyzed track just means a plain
// crossfade this once.

import { convertFileSrc } from "@tauri-apps/api/core";
import {
  analyzeTempo,
  detectBeats,
  onsetEnvelope,
  type BeatGrid,
  type TempoAnalysis,
} from "./beatgrid";

/** Head window for crossfade grids — enough to lock the mix-in tempo. */
const GRID_SECONDS = 60;
/** Whole-track cap for the BPM column; covers any album cut. */
const FULL_SECONDS = 15 * 60;
/** Decode at a modest rate: beat energy lives way below 11kHz. */
const DECODE_RATE = 22050;

const gridCache = new Map<string, Promise<BeatGrid | null>>();
const tempoCache = new Map<string, Promise<TempoAnalysis | null>>();

export function beatGridFor(path: string): Promise<BeatGrid | null> {
  let hit = gridCache.get(path);
  if (!hit) {
    // Analysis failure = no grid, never an error.
    hit = decodeEnvelope(path, GRID_SECONDS)
      .then((env) => (env ? detectBeats(env) : null))
      .catch(() => null);
    gridCache.set(path, hit);
  }
  return hit;
}

/** Whole-track tempo verdict (BPM column / sweeper). The hint (tag /
    provider value from the index) anchors octave folding; it keys the
    cache so a newly imported hint re-analyzes. */
export function tempoAnalysisFor(
  path: string,
  hintBpm?: number | null,
): Promise<TempoAnalysis | null> {
  const key = `${path}\u0000${hintBpm ?? ""}`;
  let hit = tempoCache.get(key);
  if (!hit) {
    hit = decodeEnvelope(path, FULL_SECONDS)
      .then((env) => (env ? analyzeTempo(env, hintBpm) : null))
      .catch(() => null);
    tempoCache.set(key, hit);
  }
  return hit;
}

async function decodeEnvelope(path: string, maxSeconds: number): Promise<Float32Array | null> {
  const res = await fetch(convertFileSrc(path));
  const bytes = await res.arrayBuffer();
  const ctx = new OfflineAudioContext(1, DECODE_RATE * maxSeconds, DECODE_RATE);
  const decoded = await ctx.decodeAudioData(bytes);
  const mono = decoded.getChannelData(0);
  const head = mono.subarray(0, Math.min(mono.length, DECODE_RATE * maxSeconds));
  return onsetEnvelope(head, decoded.sampleRate);
}
