// Mix points for crossfade planning: persisted per-end anchors from
// the index are the only fast path; a track the sweeper hasn't
// reached gets one on-demand Rust analysis (which also persists, so
// the fallback runs at most once per track). Never blocks playback:
// failure = no anchor = plain fade this once, never an error.

import { analyzeTrack, type PersistedVerdict } from "./ipc";
import type { MixPoint } from "./djmix";
import type { TrackRow } from "./types";

/** In-flight/settled on-demand analyses, keyed by track id: both ends
    of the same transition share one IPC call. */
const inflight = new Map<number, Promise<PersistedVerdict | null>>();

function analyzeOnce(trackId: number): Promise<PersistedVerdict | null> {
  let hit = inflight.get(trackId);
  if (!hit) {
    hit = analyzeTrack(trackId).catch(() => null);
    inflight.set(trackId, hit);
  }
  return hit;
}

/** Outgoing-side mix point: the persisted tail anchor, or one live
    analysis for tracks the sweeper hasn't reached. Null = that end
    is unstable/beatless — plan a plain fade. */
export async function tailMixPoint(t: TrackRow): Promise<MixPoint | null> {
  if (t.mix_analyzed) {
    return t.mix_tail_bpm != null && t.mix_tail_beat_sec != null
      ? { bpm: t.mix_tail_bpm, beatSec: t.mix_tail_beat_sec }
      : null;
  }
  const v = await analyzeOnce(t.id);
  return v?.tail ? { bpm: v.tail.bpm, beatSec: v.tail.beat_sec } : null;
}

/** Incoming-side mix point; see tailMixPoint. */
export async function headMixPoint(t: TrackRow): Promise<MixPoint | null> {
  if (t.mix_analyzed) {
    return t.mix_head_bpm != null && t.mix_head_beat_sec != null
      ? { bpm: t.mix_head_bpm, beatSec: t.mix_head_beat_sec }
      : null;
  }
  const v = await analyzeOnce(t.id);
  return v?.head ? { bpm: v.head.bpm, beatSec: v.head.beat_sec } : null;
}
