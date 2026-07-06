// Performance baseline for the beat-analysis pipeline (vitest bench).
// Sizes mirror production: the sweeper decodes up to FULL_SECONDS
// (15 min) at DECODE_RATE (22050Hz) per track, then runs the full
// envelope → windowed-tempo → mix-anchor chain on the main thread.
// These numbers answer "is the DSP or the decode what users feel?"
// and guard against regressions in the hot loops.

import { bench, describe } from "vitest";
import {
  analyzeTempo,
  detectBeats,
  extractMixAnchors,
  onsetEnvelope,
  ENVELOPE_HZ,
} from "./beatgrid";

/** Mirrors beatservice.ts DECODE_RATE. */
const DECODE_RATE = 22050;
/** Mirrors beatservice.ts FULL_SECONDS (whole-track cap). */
const FULL_SECONDS = 15 * 60;
/** Mirrors beatservice.ts GRID_SECONDS (head-of-track grid). */
const GRID_SECONDS = 60;
/** A typical doujin/album track length. */
const TRACK_SECONDS = 4 * 60;

/** Synthetic PCM: kick-ish decaying bursts on the beat over a noise bed. */
function pcm(bpm: number, seconds: number, rate: number): Float32Array {
  const out = new Float32Array(seconds * rate);
  // Deterministic noise bed (LCG) — Math.random would vary run-to-run.
  let seed = 42;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed / 0x7fffffff - 0.5) * 0.05;
  }
  const period = Math.round((60 / bpm) * rate);
  const burst = Math.round(0.05 * rate);
  for (let start = 0; start < out.length; start += period) {
    for (let i = 0; i < burst && start + i < out.length; i++) {
      out[start + i] += Math.sin(i * 0.3) * Math.exp(-i / (burst / 4));
    }
  }
  return out;
}

/** Synthetic onset envelope: a spike every beat (as beatgrid.test.ts). */
function clicks(bpm: number, seconds: number): Float32Array {
  const env = new Float32Array(Math.round(seconds * ENVELOPE_HZ));
  const period = 60 / bpm;
  for (let t = 0; t < seconds; t += period) {
    const idx = Math.round(t * ENVELOPE_HZ);
    if (idx < env.length) env[idx] = 1;
  }
  return env;
}

// Inputs built once — bench iterations must measure the DSP, not synthesis.
const pcmFull = pcm(150, FULL_SECONDS, DECODE_RATE);
const pcmTrack = pcm(150, TRACK_SECONDS, DECODE_RATE);
const pcmHead = pcm(150, GRID_SECONDS, DECODE_RATE);
const envFull = onsetEnvelope(pcmFull, DECODE_RATE);
const envTrack = onsetEnvelope(pcmTrack, DECODE_RATE);
const envHead = onsetEnvelope(pcmHead, DECODE_RATE);

describe("onsetEnvelope (PCM → envelope)", () => {
  bench(`15min cap (${pcmFull.length.toLocaleString()} samples)`, () => {
    onsetEnvelope(pcmFull, DECODE_RATE);
  });
  bench("4min track", () => {
    onsetEnvelope(pcmTrack, DECODE_RATE);
  });
  bench("60s head (crossfade grid)", () => {
    onsetEnvelope(pcmHead, DECODE_RATE);
  });
});

describe("detectBeats (autocorrelation)", () => {
  bench("60s head envelope", () => {
    detectBeats(envHead);
  });
  bench("15s window (analyzeTempo unit)", () => {
    detectBeats(clicks(150, 15));
  });
});

describe("analyzeTempo (windowed whole-track)", () => {
  bench("15min envelope", () => {
    analyzeTempo(envFull);
  });
  bench("4min envelope", () => {
    analyzeTempo(envTrack);
  });
});

describe("extractMixAnchors (per-end grids)", () => {
  bench("4min envelope", () => {
    extractMixAnchors(envTrack);
  });
});

describe("sweeper: full per-track DSP chain (sans decode)", () => {
  // What bpmsweep.ts costs per track once decodeAudioData returns:
  // envelope + whole-track tempo. Compare against PACE_MS (3000ms)
  // and a 16.7ms frame budget to judge main-thread impact.
  bench("4min track", () => {
    const env = onsetEnvelope(pcmTrack, DECODE_RATE);
    analyzeTempo(env);
  });
});
