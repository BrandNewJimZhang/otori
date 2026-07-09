// Row virtualization math for the library table. Fixed row height (a
// density choice, not a per-row measurement), so the visible slice is
// pure arithmetic — the table renders only [start, end) and pads the
// rest with two spacer rows so the scrollbar reflects the full list.

export interface WindowInput {
  /** Scroll offset of the container, in px. */
  scrollTop: number;
  /** Visible height of the scroll container, in px. */
  viewport: number;
  /** Uniform rendered height of one row, in px. */
  rowHeight: number;
  /** Total rows in the (already sorted/filtered) list. */
  total: number;
  /** Extra rows kept above and below the viewport to hide scroll seams. */
  overscan: number;
}

export interface RowWindow {
  /** First rendered row index (inclusive). */
  start: number;
  /** One past the last rendered row index (exclusive). */
  end: number;
  /** Spacer height standing in for rows above `start`, in px. */
  padTop: number;
  /** Spacer height standing in for rows below `end`, in px. */
  padBottom: number;
}

/**
 * New scrollTop that brings row `index` fully into view, or null when
 * it is already visible (so callers skip a no-op scroll that would
 * fight click selection). `headroom` is the sticky-header height that
 * covers the top of the scroll container.
 */
export function revealOffset(args: {
  index: number;
  scrollTop: number;
  viewport: number;
  rowHeight: number;
  headroom: number;
}): number | null {
  const { index, scrollTop, viewport, rowHeight, headroom } = args;
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  const viewTop = scrollTop + headroom;
  const viewBottom = scrollTop + viewport;
  if (top < viewTop) return Math.max(0, top - headroom);
  if (bottom > viewBottom) return bottom - viewport;
  return null;
}

export function rowWindow({ scrollTop, viewport, rowHeight, total, overscan }: WindowInput): RowWindow {
  if (total <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  }
  const firstVisible = Math.floor(scrollTop / rowHeight);
  const visibleCount = Math.ceil(viewport / rowHeight);
  const start = Math.max(0, Math.min(firstVisible - overscan, total));
  const end = Math.min(total, firstVisible + visibleCount + overscan);
  return {
    start,
    end: Math.max(start, end),
    padTop: start * rowHeight,
    padBottom: Math.max(0, (total - end) * rowHeight),
  };
}

/** Clamp a scroll offset to the container's real range. */
function clampScroll(offset: number, args: { viewport: number; rowHeight: number; total: number }): number {
  return Math.max(0, Math.min(offset, args.total * args.rowHeight - args.viewport));
}

/**
 * scrollTop that centers row `index` in the usable viewport (the part
 * below the sticky header), clamped to the scroll range. Used when the
 * anchor row's previous on-screen position is unknown or off screen.
 */
export function centerOffset(args: {
  index: number;
  viewport: number;
  rowHeight: number;
  headroom: number;
  total: number;
}): number {
  const { index, viewport, rowHeight, headroom } = args;
  const usable = viewport - headroom;
  const lead = Math.max(0, Math.floor((usable - rowHeight) / 2));
  return clampScroll(index * rowHeight - headroom - lead, args);
}

/**
 * scrollTop after a reorder (sort change) that keeps the anchor row
 * visually still: if it was on screen at `oldIndex`, it stays at the
 * same viewport offset at `newIndex`; if it was off screen (or
 * oldIndex < 0 = unknown), it is centered instead.
 */
export function reanchorOffset(args: {
  oldIndex: number;
  newIndex: number;
  scrollTop: number;
  viewport: number;
  rowHeight: number;
  headroom: number;
  total: number;
}): number {
  const { oldIndex, newIndex, scrollTop, viewport, rowHeight, headroom } = args;
  const oldTop = oldIndex * rowHeight;
  const wasVisible =
    oldIndex >= 0 &&
    oldTop >= scrollTop + headroom &&
    oldTop + rowHeight <= scrollTop + viewport;
  if (!wasVisible) return centerOffset({ index: newIndex, ...args });
  return clampScroll(newIndex * rowHeight - (oldTop - scrollTop), args);
}
