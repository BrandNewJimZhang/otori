// Artwork loader policy: the library table can show 700+ rows, so cover
// thumbnails must load only for rows the user actually looks at, each
// path fetched at most once (negative results cached too), with a hard
// cap on concurrent shell IPC so a fast scroll can't fan out 700 calls.

import { describe, expect, it, vi } from "vitest";
import { createArtworkCache } from "./artworkcache";

/** A fetch stub whose promises resolve when the test says so. */
function deferredFetch() {
  const pending = new Map<string, (v: string | null) => void>();
  const fetch = vi.fn((path: string) => {
    return new Promise<string | null>((resolve) => pending.set(path, resolve));
  });
  return {
    fetch,
    resolve(path: string, value: string | null) {
      const r = pending.get(path);
      if (!r) throw new Error(`no pending fetch for ${path}`);
      pending.delete(path);
      r(value);
    },
  };
}

describe("createArtworkCache", () => {
  it("returns undefined for a never-requested path", () => {
    const { fetch } = deferredFetch();
    const cache = createArtworkCache(fetch);
    expect(cache.get("/a.mp3")).toBeUndefined();
  });

  it("fetches a requested path once and caches the data URL", async () => {
    const { fetch, resolve } = deferredFetch();
    const cache = createArtworkCache(fetch);
    const onSettled = vi.fn();

    cache.request("/a.mp3", onSettled);
    resolve("/a.mp3", "data:image/png;base64,AAA");
    await Promise.resolve();

    expect(cache.get("/a.mp3")).toBe("data:image/png;base64,AAA");
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("caches a negative result (no embedded art) and never refetches", async () => {
    const { fetch, resolve } = deferredFetch();
    const cache = createArtworkCache(fetch);

    cache.request("/a.mp3", () => {});
    resolve("/a.mp3", null);
    await Promise.resolve();

    expect(cache.get("/a.mp3")).toBeNull();
    cache.request("/a.mp3", () => {}); // second look: must not refetch
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("dedups concurrent requests for the same in-flight path", () => {
    const { fetch } = deferredFetch();
    const cache = createArtworkCache(fetch);

    cache.request("/a.mp3", () => {});
    cache.request("/a.mp3", () => {});
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("caps concurrent fetches and drains the queue as slots free", async () => {
    const { fetch, resolve } = deferredFetch();
    const cache = createArtworkCache(fetch, { concurrency: 2 });

    cache.request("/a", () => {});
    cache.request("/b", () => {});
    cache.request("/c", () => {}); // queued behind the cap
    expect(fetch).toHaveBeenCalledTimes(2);

    resolve("/a", "data:a");
    await Promise.resolve();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(3); // /c promoted once /a freed a slot
  });

  it("still frees the slot and caches null when a fetch rejects", async () => {
    const fetch = vi.fn(() => Promise.reject(new Error("read failed")));
    const cache = createArtworkCache(fetch, { concurrency: 1 });
    const onSettled = vi.fn();

    cache.request("/bad", onSettled);
    await Promise.resolve();
    await Promise.resolve();

    expect(cache.get("/bad")).toBeNull(); // failed read reads as "no art", not retried
    expect(onSettled).toHaveBeenCalledTimes(1);

    cache.request("/next", () => {});
    expect(fetch).toHaveBeenCalledTimes(2); // slot was freed despite the rejection
  });
});
