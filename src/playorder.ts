// Playback order semantics: shuffle and repeat as pure functions, so
// the interaction rules (repeat-one vs manual skip, shuffle freezing)
// are testable without an <audio> element. App.tsx owns the state.

import { dequeue } from "./queue";

export type RepeatMode = "off" | "all" | "one";

/** Transport button cycle: off → all → one → off. */
export function cycleRepeat(mode: RepeatMode): RepeatMode {
  return mode === "off" ? "all" : mode === "all" ? "one" : "off";
}

/**
 * Fisher–Yates permutation of `ids`, with the currently playing track
 * pinned first so enabling shuffle never re-queues what's audible.
 * `rng` injected for deterministic tests.
 */
export function shuffledIds(
  ids: number[],
  currentId: number | null,
  rng: () => number,
): number[] {
  const rest = currentId == null ? [...ids] : ids.filter((id) => id !== currentId);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return currentId == null || !ids.includes(currentId) ? rest : [currentId, ...rest];
}

/**
 * Reconcile a frozen shuffle permutation with the ids currently
 * visible: keep the permutation's relative order, drop ids that were
 * filtered away, append newcomers at the end (in visible order).
 */
export function effectiveOrder(visibleIds: number[], permutation: number[]): number[] {
  const visible = new Set(visibleIds);
  const kept = permutation.filter((id) => visible.has(id));
  const inPerm = new Set(permutation);
  return [...kept, ...visibleIds.filter((id) => !inPerm.has(id))];
}

/**
 * The id to play after `currentId`, or null to stop.
 * `manual` distinguishes a user skip from a natural track end:
 * repeat-one replays only on natural ends — a skip always moves.
 */
export function nextId(
  order: number[],
  currentId: number | null,
  offset: 1 | -1,
  repeat: RepeatMode,
  manual: boolean,
): number | null {
  if (currentId == null) return null;
  const idx = order.indexOf(currentId);
  if (idx < 0) return null;
  if (repeat === "one" && !manual) return currentId;
  const next = idx + offset;
  if (next >= 0 && next < order.length) return order[next];
  // At the edge: repeat-all wraps; repeat-one wraps too on a manual
  // skip — a skip always moves, and upcomingPreview promises it goes
  // where repeat-all would (the transport must match the panel).
  if ((repeat === "all" || repeat === "one") && order.length > 0) {
    return order[(next + order.length) % order.length];
  }
  return null;
}

/** Where an advance lands: the id to play (null = stop), the queue
    after consuming/pruning, and whether the id came from the queue. */
export interface Advance {
  id: number | null;
  queue: number[];
  fromQueue: boolean;
}

/**
 * Resolve one advance through the full precedence stack — play-next
 * queue first (forward steps only; repeat-one natural replays win over
 * the queue), then the play order (frozen shuffle permutation when
 * given, visible order otherwise). Queued ids that left the library
 * are pruned in passing. The ONE authority for "what plays next":
 * manual steps, gapless preload, and crossfade targeting all resolve
 * here — three copies of this walk is how preload and step once drifted
 * apart on queue pruning.
 */
export function resolveAdvance(
  visibleIds: number[],
  queue: number[],
  currentId: number | null,
  shuffleOrder: number[] | null,
  repeat: RepeatMode,
  offset: 1 | -1,
  manual: boolean,
): Advance {
  let rest = queue;
  if (offset === 1 && !(repeat === "one" && !manual)) {
    const visible = new Set(visibleIds);
    for (;;) {
      const popped = dequeue(rest);
      if (popped.id == null) break;
      if (visible.has(popped.id)) {
        return { id: popped.id, queue: popped.rest, fromQueue: true };
      }
      rest = popped.rest; // pruned: the id left the library since queuing
    }
  }
  const order = shuffleOrder ? effectiveOrder(visibleIds, shuffleOrder) : visibleIds;
  return { id: nextId(order, currentId, offset, repeat, manual), queue: rest, fromQueue: false };
}

/**
 * The next `count` ids the play order will visit after `currentId`,
 * for the up-next panel: queued ids are skipped (the panel's queue
 * section already shows them), repeat-one previews as repeat-all (the
 * panel answers "where do skips go"), and the walk stops at the order
 * edge, on a repeat-all wraparound, or at `count`.
 */
export function upcomingPreview(
  visibleIds: number[],
  queue: number[],
  currentId: number | null,
  shuffleOrder: number[] | null,
  repeat: RepeatMode,
  count: number,
): number[] {
  const order = shuffleOrder ? effectiveOrder(visibleIds, shuffleOrder) : visibleIds;
  const queued = new Set(queue);
  const out: number[] = [];
  const seen = new Set<number>();
  let cursor = currentId;
  for (let i = 0; i < count; i++) {
    const id = nextId(order, cursor, 1, repeat === "one" ? "all" : repeat, true);
    if (id == null || id === currentId || seen.has(id)) break; // edge or wrapped
    cursor = id;
    seen.add(id);
    if (queued.has(id)) continue;
    out.push(id);
  }
  return out;
}
