// Background analysis sweeper: drains the index's pending list through
// the full-track analyzer, one track at a time, idle-priority. Persists
// the BPM column verdict (hint-anchored octave folding — see beatgrid
// applyHint) and both mix anchors, so a restart resumes where it left
// off and crossfade planning reads anchors from the index instead of
// re-decoding every session.

import { analyzeTrack } from "./beatservice";
import { listAnalysisPending, setBpm, setMixAnchors } from "./ipc";
import type { MixAnchor } from "./beatgrid";

/** Pause between tracks: keep the decode work invisible next to
    playback and UI (one full-track decode ≈ hundreds of ms; spacing
    matters more than speed — 1200 tracks still finish within a
    session). */
const PACE_MS = 3000;

let running = false;

/**
 * Start the sweep loop for this session. Idempotent; safe to call on
 * mount. Stops when the pending list drains (new scans re-arm it via
 * the library-changed handler calling this again).
 */
export function startAnalysisSweep(): void {
  if (running) return;
  running = true;
  void (async () => {
    try {
      const pending = await listAnalysisPending();
      for (const track of pending) {
        const { tempo, anchors } = await analyzeTrack(track.path, track.hint_bpm);
        // Persist even nulls (beatless / unstable ends): "analyzed,
        // nothing usable" must not be re-attempted every launch. IPC
        // failure aborts the sweep (index unavailable) rather than
        // spinning.
        if (track.needs_bpm) {
          await setBpm(
            track.id,
            tempo
              ? {
                  bpm: round1(tempo.bpm),
                  bpm_max: tempo.bpmMax != null ? round1(tempo.bpmMax) : null,
                  confidence: Math.round(tempo.confidence * 100) / 100,
                }
              : null,
            tempo?.hintApplied ?? false,
          );
        }
        // Anchors keep full precision: beat phase feeds sample math.
        await setMixAnchors(track.id, anchorArg(anchors.head), anchorArg(anchors.tail));
        await sleep(PACE_MS);
      }
    } catch {
      // Sweep is an enhancement; next launch (or next library-changed)
      // retries whatever is still pending.
    } finally {
      running = false;
    }
  })();
}

function anchorArg(a: MixAnchor | null): { bpm: number; beat_sec: number } | null {
  return a ? { bpm: a.bpm, beat_sec: a.beatSec } : null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
