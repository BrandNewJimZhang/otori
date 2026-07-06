// Playback order semantics: shuffle and repeat as pure functions, so
// the interaction rules (repeat-one vs manual skip, shuffle freezing)
// are testable without an <audio> element. App.tsx owns the state.

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
  if (repeat === "all" && order.length > 0) {
    return order[(next + order.length) % order.length];
  }
  return null;
}
