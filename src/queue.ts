// Explicit play-next queue (audit P1): user picks jump the play order.
// The queue holds track ids; App consumes the head on each natural or
// manual forward step before falling back to playorder's nextId.

/** Queue `ids` to play next (front of queue), before older picks.
    Re-queuing moves a track instead of duplicating it; a duplicated
    input batch is deduped here — the no-dup invariant is this
    function's to hold, whatever a caller passes. */
export function enqueueNext(queue: number[], ids: number[]): number[] {
  const picked = new Set(ids);
  return [...new Set(ids), ...queue.filter((id) => !picked.has(id))];
}

/** Pop the next queued id; null when the queue is empty. */
export function dequeue(queue: number[]): { id: number | null; rest: number[] } {
  if (queue.length === 0) return { id: null, rest: [] };
  const [id, ...rest] = queue;
  return { id, rest };
}

/** Drop `ids` from the queue (unqueue action, or tracks gone from the library). */
export function queueRemove(queue: number[], ids: ReadonlySet<number>): number[] {
  return queue.filter((id) => !ids.has(id));
}

/** Move `id` one slot up (-1) or down (+1); clamped, unknown ids no-op.
    Single-slot steps are all the queue panel's arrows need (audit r5). */
export function queueMove(queue: number[], id: number, offset: 1 | -1): number[] {
  const from = queue.indexOf(id);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= queue.length) return queue;
  const next = [...queue];
  next[from] = next[to];
  next[to] = id;
  return next;
}
