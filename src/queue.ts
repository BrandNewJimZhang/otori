// Explicit play-next queue (audit P1): user picks jump the play order.
// The queue holds track ids; App consumes the head on each natural or
// manual forward step before falling back to playorder's nextId.

/** Queue `ids` to play next (front of queue), before older picks.
    Re-queuing moves a track instead of duplicating it. */
export function enqueueNext(queue: number[], ids: number[]): number[] {
  const picked = new Set(ids);
  return [...ids, ...queue.filter((id) => !picked.has(id))];
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
