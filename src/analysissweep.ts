// Background analysis sweeper: drains the index's pending list through
// the Rust analyzer (analyze_track IPC), one track at a time,
// idle-priority. Rust persists each verdict, so a restart resumes
// where it left off; the frontend only paces the loop and reports
// progress for the status bar.

import { analyzeTrack, listAnalysisPending } from "./ipc";

/** Floor between tracks: even instant work never runs back-to-back. */
const PACE_MS = 3000;
/** Duty-cycle cap: sweep work stays ≤10% of wall time. Beat This!
    inference costs ~1s per minute of audio — a fixed pause would let
    a run of album cuts stack into a felt load. */
const DUTY_CYCLE = 0.1;

/** Sleep after a track that took `workMs`: the base pace, stretched
    so work/(work+sleep) ≤ DUTY_CYCLE for expensive tracks. */
export function paceDelayMs(workMs: number): number {
  return Math.max(PACE_MS, Math.round((workMs * (1 - DUTY_CYCLE)) / DUTY_CYCLE));
}

/** Sweep progress for ambient UI (status bar): tracks left in this
    run, or null when idle. */
export type SweepListener = (remaining: number | null) => void;

let running = false;
let listener: SweepListener | null = null;

/** Register the (single) progress consumer. Returns an unsubscribe. */
export function onSweepProgress(fn: SweepListener): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

function report(remaining: number | null): void {
  listener?.(remaining);
}

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
      for (let i = 0; i < pending.length; i++) {
        report(pending.length - i);
        const started = performance.now();
        // Rust analyzes AND persists; a rejection (file vanished,
        // decode error) skips that track — it stays pending and the
        // next launch retries it once the underlying cause is gone.
        await analyzeTrack(pending[i].id).catch(() => undefined);
        await sleep(paceDelayMs(performance.now() - started));
      }
    } catch {
      // Worklist unavailable (index closed?) — sweep is an
      // enhancement; next launch or library-changed retries.
    } finally {
      report(null);
      running = false;
    }
  })();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
