// DJ transition planning: what a human DJ does at the mixer, as data.
// Tempo-compatible pairs get a beat-matched plan (rate ramps + bar-
// quantized duration + downbeat alignment); everything else falls back
// to a plain equal-power crossfade with the degrade reason attached.
// The playback engine executes plans (phase-aligning the entry at the
// anchor instant via alignEntry); this module only computes them
// (pure, tested).

/** Max pitch bend during a mix: ±12% (modern controller pitch range;
    the ramp settles back to unity, so the bend is transient). Also
    the shuffle chain's tempo-compatibility window — one authority. */
export const MAX_RATE_STRETCH = 0.12;

/**
 * A local beat grid at the point where a track meets the mix: the
 * outgoing track's TAIL anchor or the incoming track's HEAD anchor
 * (persisted per end — a whole-track tempo can't stand in for either
 * on variable-tempo material). `beatSec` is any beat inside that
 * window, in absolute track seconds.
 */
export interface MixPoint {
  bpm: number;
  beatSec: number;
}

export interface DeckRamp {
  /** playbackRate at the start / end of the transition. */
  rateFrom: number;
  rateTo: number;
  /** Seconds into the track where it should start sounding. */
  startOffsetSec: number;
}

/** Why a pair degraded to a plain fade — surfaced to the user so a
    "mix that sounds like crossfade" is diagnosable, not a mystery. */
export type PlainReason = "missing-anchor" | "tempo-gap";

export type TransitionPlan =
  | {
      kind: "beatmatched";
      durationSec: number;
      outgoing: DeckRamp;
      incoming: DeckRamp;
      /** The grids the plan was computed from: the engine re-reads
          them at the fade anchor to phase-align the entry (planning
          time can't know the anchor instant — spin-up latency). */
      outGrid: MixPoint;
      inGrid: MixPoint;
      gainOut: (t: number) => number;
      gainIn: (t: number) => number;
    }
  | {
      kind: "plain";
      durationSec: number;
      reason: PlainReason;
      gainOut: (t: number) => number;
      gainIn: (t: number) => number;
    };

/** Equal-power fade curves: out²+in² = 1 for constant loudness. */
const equalPower = {
  gainOut: (t: number) => Math.cos((Math.min(1, Math.max(0, t)) * Math.PI) / 2),
  gainIn: (t: number) => Math.sin((Math.min(1, Math.max(0, t)) * Math.PI) / 2),
};

const plainPlan = (durationSec: number, reason: PlainReason): TransitionPlan => ({
  kind: "plain",
  durationSec,
  reason,
  ...equalPower,
});

/** Euclidean modulo: beat grids extrapolated backward past track zero
    carry negative anchors, and JS truncated % would misplace those. */
const emod = (a: number, m: number) => ((a % m) + m) % m;

/**
 * Fold an incoming/outgoing BPM ratio into mixable range: DJs pair
 * half/double tempos (87 dnb over 174 halftime) at the folded ratio.
 */
function foldedRatio(from: number, to: number): number {
  let ratio = to / from;
  while (ratio > 1.5) ratio /= 2;
  while (ratio < 0.66) ratio *= 2;
  return ratio;
}

/** Whether two beat grids are close enough in tempo to beat-match,
    after half/double folding. The single tempo-compatibility authority:
    planTransition gates on it, and shuffle uses it to chain tracks. */
export function temposCompatible(fromBpm: number, toBpm: number): boolean {
  const usable =
    Number.isFinite(fromBpm) && fromBpm > 0 && Number.isFinite(toBpm) && toBpm > 0;
  return usable && Math.abs(foldedRatio(fromBpm, toBpm) - 1) <= MAX_RATE_STRETCH;
}

/**
 * Plan the transition between two tracks from the outgoing TAIL
 * anchor and the incoming HEAD anchor. Either missing (unstable end,
 * beatless, not yet analyzed) → plain equal-power fade. `requestedSec`
 * is advisory: beat-matched plans quantize it to whole bars (4/4
 * assumed — this library is electronic) of the outgoing tail tempo.
 */
export function planTransition(
  outgoingTail: MixPoint | null,
  incomingHead: MixPoint | null,
  requestedSec: number,
): TransitionPlan {
  if (!outgoingTail || !incomingHead) {
    return plainPlan(requestedSec, "missing-anchor");
  }
  // Corrupt-anchor guard (silver DJ-1/2/3/4, gold-adjudicated): a bpm
  // that is zero, negative, NaN, or infinite is a failed analysis, not
  // a mixable grid. Unguarded, the fold loop diverges (0, ±Infinity)
  // or — worse — NaN slips PAST every comparison and ships an all-NaN
  // beatmatched plan to the engine. Positive-finite or plain fade.
  const gridsUsable =
    Number.isFinite(outgoingTail.bpm) && outgoingTail.bpm > 0 &&
    Number.isFinite(incomingHead.bpm) && incomingHead.bpm > 0;
  if (!gridsUsable) {
    return plainPlan(requestedSec, "missing-anchor");
  }
  if (!temposCompatible(outgoingTail.bpm, incomingHead.bpm)) {
    return plainPlan(requestedSec, "tempo-gap");
  }
  const ratio = foldedRatio(outgoingTail.bpm, incomingHead.bpm);

  // Bar-quantize the duration to the outgoing tail tempo (4/4).
  const barSec = (60 / outgoingTail.bpm) * 4;
  const bars = Math.max(1, Math.round(requestedSec / barSec));
  const durationSec = bars * barSec;

  // Incoming starts on its own downbeat nearest to a musically useful
  // entry (skip at least the first beat; land on a bar boundary of its
  // own grid so the phrase lines up). Euclidean phase folds the anchor
  // beat back to the first beat of the head window before stepping in.
  const inPeriod = 60 / incomingHead.bpm;
  const inBar = inPeriod * 4;
  const beatPhase = emod(incomingHead.beatSec, inPeriod);
  const startOffsetSec = beatPhase + inBar; // enter at bar 2

  return {
    kind: "beatmatched",
    durationSec,
    outgoing: {
      rateFrom: 1,
      rateTo: ratio, // ramp the ending track toward the new tempo
      startOffsetSec: 0,
    },
    incoming: {
      rateFrom: 1 / ratio, // start matched to the outgoing tempo...
      rateTo: 1, // ...and settle at its own natural rate
      startOffsetSec,
    },
    outGrid: outgoingTail,
    inGrid: incomingHead,
    ...equalPower,
  };
}

/** Toast copy for a MIX transition that degraded to a plain fade —
    keyed off the plan's reason so "mix sounds like crossfade" is
    diagnosable at the moment it happens. */
export function mixFallbackNotice(reason: PlainReason, fromTitle: string, toTitle: string): string {
  const cause =
    reason === "missing-anchor" ? "no beat grid on one end" : "tempos too far apart";
  return `MIX: plain fade ${fromTitle} → ${toTitle} (${cause})`;
}

/**
 * Phase-lock the incoming entry to the outgoing deck at the fade
 * anchor: given where the outgoing track actually is the moment the
 * incoming deck starts sounding (play() resolved — spin-up latency
 * included), place the entry so both decks' next beats land on the
 * same wall-clock instant. The planned startOffsetSec sits ON the
 * incoming grid; adding the outgoing beat-phase fraction times the
 * INCOMING period keeps the offset in incoming track-time, and the
 * incoming deck's rateFrom (= outPeriod/inPeriod in wall time) makes
 * the two intervals meet. Symmetric linear ramps preserve equal
 * instantaneous tempo from there, so the lock holds through the fade.
 */
export function alignEntry(
  plan: Extract<TransitionPlan, { kind: "beatmatched" }>,
  outgoingPosSec: number,
): number {
  const outPeriod = 60 / plan.outGrid.bpm;
  const inPeriod = 60 / plan.inGrid.bpm;
  const phaseFrac = emod(outgoingPosSec - plan.outGrid.beatSec, outPeriod) / outPeriod;
  return plan.incoming.startOffsetSec + phaseFrac * inPeriod;
}
