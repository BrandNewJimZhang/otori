// DJ transition planning: what a human DJ does at the mixer, as data.
// Tempo-compatible pairs get a beat-matched plan (rate ramps + bar-
// quantized duration + downbeat alignment); everything else falls back
// to a plain equal-power crossfade. The playback engine executes plans;
// this module only computes them (pure, tested).

/** Max pitch bend a listener won't clock: ±8% (industry nudge range). */
const MAX_RATE_STRETCH = 0.08;

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

export type TransitionPlan =
  | {
      kind: "beatmatched";
      durationSec: number;
      outgoing: DeckRamp;
      incoming: DeckRamp;
      gainOut: (t: number) => number;
      gainIn: (t: number) => number;
    }
  | {
      kind: "plain";
      durationSec: number;
      gainOut: (t: number) => number;
      gainIn: (t: number) => number;
    };

/** Equal-power fade curves: out²+in² = 1 for constant loudness. */
const equalPower = {
  gainOut: (t: number) => Math.cos((Math.min(1, Math.max(0, t)) * Math.PI) / 2),
  gainIn: (t: number) => Math.sin((Math.min(1, Math.max(0, t)) * Math.PI) / 2),
};

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
    return { kind: "plain", durationSec: requestedSec, ...equalPower };
  }
  const ratio = foldedRatio(outgoingTail.bpm, incomingHead.bpm);
  if (Math.abs(ratio - 1) > MAX_RATE_STRETCH) {
    return { kind: "plain", durationSec: requestedSec, ...equalPower };
  }

  // Bar-quantize the duration to the outgoing tail tempo (4/4).
  const barSec = (60 / outgoingTail.bpm) * 4;
  const bars = Math.max(1, Math.round(requestedSec / barSec));
  const durationSec = bars * barSec;

  // Incoming starts on its own downbeat nearest to a musically useful
  // entry (skip at least the first beat; land on a bar boundary of its
  // own grid so the phrase lines up). Fold the anchor beat back to the
  // first beat of the head window before stepping in.
  const inPeriod = 60 / incomingHead.bpm;
  const inBar = inPeriod * 4;
  const startOffsetSec = (incomingHead.beatSec % inPeriod) + inBar; // enter at bar 2

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
    ...equalPower,
  };
}
