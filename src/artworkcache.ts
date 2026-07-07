// Lazy artwork loader for the library table. The table can list 700+
// rows; a naive `getArtwork` per row would fan out that many shell IPC
// calls on scan. This cache fetches only paths the table asks for (the
// visible rows, via IntersectionObserver in LibraryTable), fetches each
// path at most once — caching the negative "no embedded art" result too
// so a scroll back never refetches — and caps concurrent IPC so a fast
// flick can't stampede the shell. Pure state machine; the React side
// injects the fetch (ipc.getArtwork) and re-renders on the settle
// callback.

/** A resolved artwork slot: a data URL, or null when the file has none. */
type Resolved = string | null;

export interface ArtworkCache {
  /** Cached result, or undefined if never fetched / still in flight. */
  get(path: string): Resolved | undefined;
  /** Ensure `path` is (being) fetched; `onSettled` fires once it lands. */
  request(path: string, onSettled: () => void): void;
}

// One in-flight cap covers the whole table: high enough to fill a
// viewport quickly, low enough that a fling doesn't queue 700 IPCs.
const DEFAULT_CONCURRENCY = 6;

export function createArtworkCache(
  fetch: (path: string) => Promise<Resolved>,
  opts: { concurrency?: number } = {},
): ArtworkCache {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const resolved = new Map<string, Resolved>();
  const inFlight = new Set<string>();
  const queue: string[] = [];
  // Settle callbacks per path — multiple rows can await the same cover
  // (e.g. same file surfaced twice); every waiter is notified once.
  const waiters = new Map<string, Set<() => void>>();

  function settle(path: string, value: Resolved) {
    resolved.set(path, value);
    inFlight.delete(path);
    const cbs = waiters.get(path);
    waiters.delete(path);
    cbs?.forEach((cb) => cb());
    pump();
  }

  function pump() {
    while (inFlight.size < concurrency && queue.length > 0) {
      const path = queue.shift()!;
      // Guard: a path can be queued then resolved via dedup before its
      // turn; skip anything already settled or promoted.
      if (resolved.has(path) || inFlight.has(path)) continue;
      inFlight.add(path);
      // A failed read reads as "no art" (null) — not a hard error and
      // not retried; the slot frees either way (single handling site).
      fetch(path).then(
        (value) => settle(path, value),
        () => settle(path, null),
      );
    }
  }

  return {
    get(path) {
      return resolved.get(path);
    },
    request(path, onSettled) {
      if (resolved.has(path)) return; // already known, positive or negative
      let set = waiters.get(path);
      if (!set) {
        set = new Set();
        waiters.set(path, set);
      }
      set.add(onSettled);
      if (inFlight.has(path) || queue.includes(path)) return; // dedup
      queue.push(path);
      pump();
    },
  };
}
