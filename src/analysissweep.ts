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
/** How many recent tracks the ETA averages over. Few enough to track a
    shift (long compilations → short cuts), enough to absorb outliers. */
const ETA_WINDOW = 8;
/** Below this many samples the ETA is too noisy to show. */
const ETA_MIN_SAMPLES = 4;

/** Sleep after a track that took `workMs`: the base pace, stretched
    so work/(work+sleep) ≤ DUTY_CYCLE for expensive tracks. */
export function paceDelayMs(workMs: number): number {
  return Math.max(PACE_MS, Math.round((workMs * (1 - DUTY_CYCLE)) / DUTY_CYCLE));
}

/** Per-track wall time = decode + its pace gap; the duty-cycle cap
    makes the pace gap dominate for expensive tracks, so the mean
    already reflects real cost. Rolling mean over the trailing
    ETA_WINDOW, projected across `remaining` tracks. Null until
    ETA_MIN_SAMPLES seed it (or nothing remains). */
export function computeEtaMs(
  recentWallMs: number[],
  remaining: number,
): number | null {
  if (remaining <= 0 || recentWallMs.length < ETA_MIN_SAMPLES) return null;
  const window = recentWallMs.slice(-ETA_WINDOW);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  return Math.round(mean * remaining);
}

/** Sweep progress for ambient UI (status bar): the current track id
    (so App can resolve its title), the tracks left, and a wall-clock
    ETA — or null when the sweep is idle. */
export interface SweepProgress {
  /** The track the sweep is currently analyzing, or null between
      tracks / while the worklist loads. */
  currentId: number | null;
  remaining: number;
  etaMs: number | null;
}

export type SweepListener = (p: SweepProgress | null) => void;

let running = false;
let listener: SweepListener | null = null;

/** Register the (single) progress consumer. Returns an unsubscribe. */
export function onSweepProgress(fn: SweepListener): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

function report(p: SweepProgress | null): void {
  listener?.(p);
}

/**
 * Start the sweep loop for this session. Idempotent; safe to call on
 * mount. Stops when the pending list drains (new scans re-arm it via
 * the library-changed handler calling this again).
 */
export function startAnalysisSweep(): void {
  if (running) return;
  running = true;
  const recent: number[] = [];
  void (async () => {
    try {
      const pending = await listAnalysisPending();
      for (let i = 0; i < pending.length; i++) {
        const remaining = pending.length - i;
        report({ currentId: pending[i].id, remaining, etaMs: computeEtaMs(recent, remaining) });
        const started = performance.now();
        // Rust analyzes AND persists; a rejection (file vanished,
        // decode error) skips that track — it stays pending and the
        // next launch retries it once the underlying cause is gone.
        await analyzeTrack(pending[i].id).catch(() => undefined);
        const workMs = performance.now() - started;
        recent.push(workMs + paceDelayMs(workMs));
        await sleep(paceDelayMs(workMs));
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
