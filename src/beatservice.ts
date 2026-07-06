// Track beat analysis service: decode → onset envelope → beat grid,
// cached per path. Runs on the WebView's decodeAudioData (off-main
// decode) at preload time, so a grid is ready before a transition
// needs it. Never blocks playback: an unanalyzed track just means a
// plain crossfade this once. Cache is per-session; persisting grids
// into the library db can come later if decode cost ever matters.

import { convertFileSrc } from "@tauri-apps/api/core";
import { detectBeats, onsetEnvelope, type BeatGrid } from "./beatgrid";

/** Analyze only this much from the head — enough to lock tempo. */
const ANALYZE_SECONDS = 60;
/** Decode at a modest rate: beat energy lives way below 11kHz. */
const DECODE_RATE = 22050;

const cache = new Map<string, Promise<BeatGrid | null>>();

export function beatGridFor(path: string): Promise<BeatGrid | null> {
  let hit = cache.get(path);
  if (!hit) {
    hit = analyze(path).catch(() => null); // analysis failure = no grid, never an error
    cache.set(path, hit);
  }
  return hit;
}

async function analyze(path: string): Promise<BeatGrid | null> {
  const res = await fetch(convertFileSrc(path));
  const bytes = await res.arrayBuffer();
  const ctx = new OfflineAudioContext(1, DECODE_RATE * ANALYZE_SECONDS, DECODE_RATE);
  const decoded = await ctx.decodeAudioData(bytes);
  const mono = decoded.getChannelData(0);
  const head = mono.subarray(0, Math.min(mono.length, DECODE_RATE * ANALYZE_SECONDS));
  return detectBeats(onsetEnvelope(head, decoded.sampleRate));
}
