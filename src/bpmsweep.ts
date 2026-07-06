// Background BPM sweeper: drains the index's pending list through the
// existing beatgrid detector, one track at a time, idle-priority. The
// beatservice cache stays the fast path for imminent transitions; this
// fills the BPM column for the whole library over time. Results land
// in the index (set_bpm), so a restart resumes where it left off and
// the CLI/agents see the same numbers.

import { beatGridFor } from "./beatservice";
import { listBpmPending, setBpm } from "./ipc";

/** Pause between tracks: keep the decode work invisible next to
    playback and UI (one 60s decode ≈ tens of ms; spacing matters
    more than speed — 1200 tracks still finish within a session). */
const PACE_MS = 3000;

let running = false;

/**
 * Start the sweep loop for this session. Idempotent; safe to call on
 * mount. Stops when the pending list drains (new scans re-arm it via
 * the library-changed handler calling this again).
 */
export function startBpmSweep(): void {
  if (running) return;
  running = true;
  void (async () => {
    try {
      const pending = await listBpmPending();
      for (const track of pending) {
        const grid = await beatGridFor(track.path);
        // Persist even null (beatless): "analyzed, no beat" must not
        // be re-attempted every launch. IPC failure aborts the sweep
        // (index unavailable) rather than spinning.
        await setBpm(track.id, grid ? round1(grid.bpm) : null);
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

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
